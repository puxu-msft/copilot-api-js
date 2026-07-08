/**
 * Recoverable background backfill that MIGRATES historical rows from the legacy
 * stage shape into the new client/upstream stage shape (RFC 2026-07-07 §3), so
 * the read-time legacy→new adapter (`adaptLegacyLegsInPlace`, serialize.ts) can
 * eventually be dropped for a single-track store.
 *
 * Three historical layouts all converge to one new-shape row:
 *   - legacy STAGE-SPLIT rows: `inbound_request` / `effective_request` /
 *     `outbound_request` / `outbound_response` / `inbound_response` / `sse_events`
 *     stages (possibly folded into a `request_group` frame) + a head-meta blob.
 *   - legacy SINGLE-BLOB rows: NO stage rows; the head blob IS the full entry with
 *     the heavy legs inline.
 *   - already-NEW rows written before this marker column existed (born new-shape
 *     but stages_migrated defaulted to 0 on the ALTER): re-serialized idempotently.
 *
 * The transform per row is exactly the finalize write path, replayed:
 *   assembleFullEntry(head, oldStages)   → the read adapter fills the new legs
 *   extractStagePayloads(entry)          → the new client/upstream stage payloads
 *   partitionStagesForWrite(...)         → the request_group dedup frame + rest
 *   extractHeadMetaPayload(entry)        → the stripped head-meta blob
 * then INSERT-OR-REPLACE the entry's stage rows (+ re-pack request_group) and
 * overwrite the head blob with the stripped meta. The indexed head COLUMNS
 * (model / tokens / status / bytes …) are left untouched — only `blob_gz` (heavy
 * legs move out to stages) and the `stages_migrated` marker change.
 *
 * Idempotency (破坏性变换铁律①): per-row marker `entries_v2.stages_migrated`. The
 * scan only touches `stages_migrated = 0` rows and sets it to 1 in the SAME
 * per-entry tx as the rewrite; every row written by the current producers is born
 * 1 (buildHeadRow), so a new / re-finalized row is never re-serialized. The marker
 * — not the cursor — is the correctness guarantee.
 *
 * Ordering dependency on usage-normalize (破坏性变换铁律②, exclude a sibling path's
 * already-transformed subset): usage-normalize-backfill nets the usage in the
 * LEGACY `outbound_response` stage / head blob. Once we rewrite those into
 * `upstream_response` stages and strip the head blob, usage-normalize can no longer
 * find them — it would net the COLUMN but not the blob → list/detail divergence
 * (usage-normalize 铁律③). So this backfill DEFERS until usage-normalize has fully
 * completed (its version flag set); by then every row is usage_normalized=1 and the
 * net usage rides through assembleFullEntry into the new `upstream_response` leg.
 *
 * Equivalence oracle (破坏性变换必带): BEFORE committing, the freshly-built new-shape
 * row is read back via `assembleFullEntry` and its consumer projection — the new
 * stage payloads (`extractStagePayloads`) + the derived indexed columns
 * (`buildHeadRow`) — is compared field-for-field against the pre-migration read.
 * A mismatch skips the row WITHOUT marking it (never corrupts; retried next run).
 *
 * Cooperative shutdown mirrors the sibling backfills: `shutdownHistory` calls
 * `stopLegacyStageBackfill()` BEFORE `closeDatabase()` (this loop must NOT
 * subscribe to the late abort signal — a post-close prepare would throw), and
 * every DB op is under try/catch so a close that races the loop ends gracefully.
 * NEVER throws (background work — an escaped rejection could crash the process).
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import type { HistoryEntry } from "~/lib/history/types"

import type { Database } from "./connection"

import {
  //
  compress,
} from "./compression"
import {
  //
  getMeta,
  setMeta,
  STAGE_MIGRATE_CURSOR_KEY,
  STAGE_MIGRATE_VERSION,
  STAGE_MIGRATE_VERSION_KEY,
  USAGE_NORMALIZE_VERSION,
  USAGE_NORMALIZE_VERSION_KEY,
} from "./meta"
import {
  //
  assembleFullEntry,
  buildHeadRow,
  type EntryRow,
  extractHeadMetaPayload,
  extractStagePayloads,
  partitionStagesForWrite,
  type StagePayload,
  type StageRow,
} from "./serialize"

/** Entry batch size; the loop yields to the event loop after each batch. */
const BACKFILL_BATCH_SIZE = 50

/** Checkpoint the WAL every N batches so a long backfill doesn't balloon `-wal`. */
const CHECKPOINT_EVERY_BATCHES = 20

/** Cooperative stop flag (set by stopLegacyStageBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `shutdownHistory` BEFORE `closeDatabase`. */
export function stopLegacyStageBackfill(): void {
  stopRequested = true
}

/**
 * Read the stop flag through a function so TS control-flow analysis does not
 * narrow it to a constant `false` inside the loop — it is mutated EXTERNALLY
 * (during an `await`), which flow analysis can't see.
 */
function isStopRequested(): boolean {
  return stopRequested
}

/** Reset module-global backfill state (test isolation — registered in RESETTERS). */
export function resetLegacyStageBackfillForTests(): void {
  stopRequested = false
  running = false
}

interface BackfillCounts {
  migrated: number
  skipped: number
  errors: number
}

/** One id-scan row: id + started_at (the head row + stages are loaded per batch). */
interface ScanRow {
  id: string
  started_at: number
}

/** Load full head rows for a batch of ids, keyed by id. */
function loadHeadRows(db: Database, ids: Array<string>): Map<string, EntryRow> {
  const map = new Map<string, EntryRow>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = db.prepare(`SELECT * FROM entries_v2 WHERE id IN (${placeholders})`).all(...ids) as Array<EntryRow>
  for (const row of rows) map.set(row.id, row)
  return map
}

/** Load all stage rows for a batch of ids, grouped by entry_id. */
function loadStageRows(db: Database, ids: Array<string>): Map<string, Array<StageRow>> {
  const map = new Map<string, Array<StageRow>>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = db
    .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id IN (${placeholders})`)
    .all(...ids) as Array<StageRow>
  for (const row of rows) {
    const list = map.get(row.entry_id)
    if (list) list.push(row)
    else map.set(row.entry_id, [row])
  }
  return map
}

/** Recursively rebuild `value` with object keys sorted + undefined dropped — an order-independent stringify basis. */
function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => sortDeep(item))
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue
    out[key] = sortDeep(obj[key])
  }
  return out
}

/** Order-independent structural stringify (for the equivalence oracle). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

/** A stage payload compressed off-tx, ready for the per-entry write transaction. */
interface PrecompressedStage {
  stage: string
  attemptIndex: number
  blob: Uint8Array
}

/** The off-tx computed result for one entry: the new head blob + new stage rows. */
interface MigrationPlan {
  headBlob: Uint8Array
  stages: Array<PrecompressedStage>
}

/**
 * Compare the consumer-visible projection of two assembled entries: the new stage
 * payloads read consumers reconstruct (`extractStagePayloads`) + the derived
 * indexed columns the list/stats view reads (`buildHeadRow`, excluding blob_gz —
 * both sides pass the same dummy blob). The legacy read-shape fields lingering on
 * `before` (old legs) are deliberately ignored: no consumer reads them, and
 * shedding them is the whole point of the migration. Equal ⟺ the migration is
 * lossless for everything a consumer can observe.
 */
function projectionEqual(before: HistoryEntry, after: HistoryEntry): boolean {
  if (stableStringify(extractStagePayloads(before)) !== stableStringify(extractStagePayloads(after))) return false
  const dummy = new Uint8Array()
  const colsBefore = buildHeadRow(before, undefined, dummy) as unknown as Record<string, unknown>
  const colsAfter = buildHeadRow(after, undefined, dummy) as unknown as Record<string, unknown>
  const { blob_gz: _b, ...restBefore } = colsBefore
  const { blob_gz: _a, ...restAfter } = colsAfter
  return stableStringify(restBefore) === stableStringify(restAfter)
}

/**
 * Compute the new-shape migration for one entry OFF-tx (decompress + reassemble +
 * re-serialize + recompress), then verify the equivalence oracle by reading the
 * planned new layout back through `assembleFullEntry`. Returns the plan, or null
 * when the entry is a lossy transform (caller then skips WITHOUT marking) —
 * decode failures also surface as null.
 */
function planMigration(head: EntryRow, stageRows: Array<StageRow>, now: number): MigrationPlan | null {
  // Read the entry via the legacy→new adapter — this fills the new client/upstream
  // legs regardless of the source layout (legacy stages / single-blob / already-new).
  const before = assembleFullEntry(head, stageRows)

  // Re-serialize exactly as the finalize write path does: new-leg stages, packed
  // into the request_group dedup frame, + the stripped head-meta blob.
  const { groupRow, rest } = partitionStagesForWrite(extractStagePayloads(before))
  const stagesToWrite: Array<StagePayload> = groupRow ? [...rest, groupRow] : rest
  const plan: MigrationPlan = {
    headBlob: compress(extractHeadMetaPayload(before)),
    stages: stagesToWrite.map((s) => ({ stage: s.stage, attemptIndex: s.attemptIndex, blob: compress(s.payload) })),
  }

  // Equivalence oracle: read the planned new layout back and compare the consumer
  // projection against the pre-migration read. Independent round-trip — not a
  // self-check on the code that produced it.
  const newHead: EntryRow = { ...head, blob_gz: plan.headBlob, stages_migrated: 1 }
  const newStageRows: Array<StageRow> = plan.stages.map((s) => ({
    entry_id: head.id,
    stage: s.stage,
    attempt_index: s.attemptIndex,
    created_at: now,
    blob_gz: s.blob,
  }))
  const after = assembleFullEntry(newHead, newStageRows)
  if (!projectionEqual(before, after)) return null
  return plan
}

/**
 * Migrate one batch: for each row, plan the new-shape migration off-tx, then in a
 * per-entry tx overwrite the head blob + marker and replace the stage rows. A row
 * that fails the oracle (or whose blob is undecodable) is skipped WITHOUT marking —
 * it stays legacy (fully readable via the adapter) and is retried next full run.
 * Mutates `counts`.
 */
function processBatch(db: Database, scanRows: Array<ScanRow>, counts: BackfillCounts): void {
  const ids = scanRows.map((r) => r.id)
  const heads = loadHeadRows(db, ids)
  const stagesById = loadStageRows(db, ids)
  const now = Date.now()

  const setHeadStmt = db.prepare("UPDATE entries_v2 SET blob_gz = ?, stages_migrated = 1 WHERE id = ?")
  const deleteStagesStmt = db.prepare("DELETE FROM entry_stages WHERE entry_id = ?")
  const insertStageStmt = db.prepare("INSERT OR REPLACE INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)")

  for (const scan of scanRows) {
    try {
      const head = heads.get(scan.id)
      if (!head) {
        counts.skipped += 1
        continue
      }
      const plan = planMigration(head, stagesById.get(scan.id) ?? [], now)
      if (!plan) {
        // Lossy transform or undecodable blob → leave stages_migrated=0 (retried),
        // the row stays fully readable through the legacy adapter (never corrupted).
        counts.errors += 1
        consola.debug(`[legacy-stage-backfill] skipped entry ${scan.id} (oracle mismatch / undecodable)`)
        continue
      }
      const tx = db.transaction(() => {
        setHeadStmt.run(plan.headBlob, scan.id)
        deleteStagesStmt.run(scan.id)
        for (const s of plan.stages) insertStageStmt.run(scan.id, s.stage, s.attemptIndex, now, s.blob)
      })
      tx()
      counts.migrated += 1
    } catch (err: unknown) {
      // Undecodable blob (or a DB op raced shutdown). Leave stages_migrated=0 — the
      // row stays legacy (readable via the adapter) and is retried on the next run.
      counts.errors += 1
      consola.debug(`[legacy-stage-backfill] skipped entry ${scan.id}`, err)
    }
  }
}

/**
 * Migrate every legacy-shape row into the new client/upstream stage shape, once.
 * Deferred until usage-normalize completes; guarded by `stage_migrate_version`;
 * resumable via the cursor + per-row marker; cooperatively stoppable. NEVER throws
 * (background work — an escaped rejection could crash the process).
 */
export async function runLegacyStageBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, STAGE_MIGRATE_VERSION_KEY) === STAGE_MIGRATE_VERSION) return

    // Ordering dependency (see file header): usage-normalize must fully finish
    // first, else migrating a not-yet-netted legacy row would strand its usage in a
    // form usage-normalize can no longer reach → list/detail divergence. Retry on a
    // later start once its version flag is set (by then every row is net + marked).
    if (getMeta(db, USAGE_NORMALIZE_VERSION_KEY) !== USAGE_NORMALIZE_VERSION) {
      consola.debug("[legacy-stage-backfill] deferring — usage-normalize backfill not yet complete")
      return
    }

    const cursorRaw = getMeta(db, STAGE_MIGRATE_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts: BackfillCounts = { migrated: 0, skipped: 0, errors: 0 }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE stages_migrated = 0").get() as { n: number }).n

    // Compound (started_at, id) keyset over the NOT-yet-migrated rows. As rows flip
    // to stages_migrated=1 they drop out of the predicate, so the cursor + marker
    // together are lossless across ties and restarts.
    const scanStmt = db.prepare(
      "SELECT id, started_at FROM entries_v2 WHERE stages_migrated = 0 AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
    )
    let boundaryTs = cursorTs
    let lastId = ""
    let batchIndex = 0

    for (;;) {
      if (isStopRequested()) break
      let scanRows: Array<ScanRow>
      try {
        scanRows = scanStmt.all(boundaryTs, boundaryTs, lastId, BACKFILL_BATCH_SIZE) as Array<ScanRow>
      } catch (err: unknown) {
        // DB closed under us (shutdown raced the loop) — cursor already saved.
        consola.debug("[legacy-stage-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, STAGE_MIGRATE_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[legacy-stage-backfill] batch failed (db closing?) — stopping", err)
        return
      }

      batchIndex += 1
      if (batchIndex % CHECKPOINT_EVERY_BATCHES === 0) {
        try {
          db.exec("PRAGMA wal_checkpoint(PASSIVE);")
        } catch {
          // best-effort
        }
      }
      if (scanRows.length < BACKFILL_BATCH_SIZE) break // reached the tail
      await sleep(0)
    }

    if (!isStopRequested()) {
      setMeta(db, STAGE_MIGRATE_VERSION_KEY, STAGE_MIGRATE_VERSION)
      if (total > 0) {
        consola.info(`[legacy-stage-backfill] complete: migrated ${counts.migrated}, skipped ${counts.skipped}, errors ${counts.errors} (of ${total})`)
      }
    }
  } catch (err: unknown) {
    consola.warn("[legacy-stage-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
