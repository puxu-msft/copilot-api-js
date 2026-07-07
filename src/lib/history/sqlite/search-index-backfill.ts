/**
 * Recoverable background backfill that builds the content-addressed search_index
 * for all historical rows AND recomputes the denormalized `preview_text` column.
 *
 * This SUPERSEDES the old inbound-only preview-backfill: building the search
 * index needs multiple legs per entry (inbound + outbound_request for
 * rewrites-req, the response legs for rewrites-resp, the header legs), so each
 * entry is fully decoded via `assembleFullEntry` — `preview_text` recompute then
 * rides along for free. The cost is real (full decode, incl. the large
 * sse_events leg) — hence BACKGROUND + CHUNKED + RESUMABLE, expected to take
 * minutes on a multi-GB DB, never blocking startup.
 *
 * Resumability (RFC C2):
 *   - **Guard**: `history_meta(search_index_version)` — runs iff it is NOT yet
 *     SEARCH_INDEX_VERSION. NEVER reads `PRAGMA user_version` (a pre-existing DB
 *     may already be at user_version=1 from the old preview-backfill).
 *   - **Per-entry idempotency**: `SELECT 1 FROM req_msg WHERE req_id=?` skips an
 *     already-built entry (so a re-run / resume neither misses nor duplicates).
 *   - **Cursor**: `history_meta(search_index_backfill_cursor)` holds the last
 *     processed `started_at`; a restart resumes from it (re-including the whole
 *     boundary timestamp, the already-built prefix de-duped by the per-entry
 *     guard). Within a run, precise compound `(started_at, id)` keyset pagination
 *     advances past ties (a started_at cluster larger than one batch is lossless).
 *   - **Completion flag**: `search_index_version` is set ONLY after the whole
 *     table is processed — until then `/api/search` inbound results are partial.
 *
 * Cooperative shutdown (RFC C1 — lifecycle is the subtle part):
 *   `shutdownHistory()` runs in graceful Phase 1 and `closeDatabase()`s the DB
 *   long before Phase 3's `getShutdownSignal()` — so this loop must NOT subscribe
 *   to the abort signal (a post-close `prepare` would throw on a dead handle).
 *   Instead `shutdownHistory` calls `stopSearchIndexBackfill()` (sets a flag)
 *   BEFORE `closeDatabase()`; the loop checks the flag at each batch boundary and
 *   exits after persisting + cursor-saving the current batch. Hard-kill fallback:
 *   the cursor is saved per batch, so a restart resumes; and every DB op is under
 *   a try/catch so a close that races the loop ends it gracefully, never crashing.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import { extractPreviewText } from "~/lib/history/in-flight"

import type { Database } from "./connection"

import {
  //
  getMeta,
  SEARCH_BACKFILL_CURSOR_KEY,
  SEARCH_INDEX_DEDUP_RATIO_KEY,
  SEARCH_INDEX_VERSION,
  SEARCH_INDEX_VERSION_KEY,
  setMeta,
} from "./meta"
import {
  //
  buildSearchIndexForEntry,
  persistSearchIndex,
} from "./search-index-write"
import {
  //
  assembleFullEntry,
  type EntryRow,
  type StageRow,
} from "./serialize"

/** Entry-id batch size; the loop yields to the event loop after each batch. */
const BACKFILL_BATCH_SIZE = 50

/** Checkpoint the WAL every N batches so a long backfill doesn't balloon `-wal`. */
const CHECKPOINT_EVERY_BATCHES = 20

/** Min req_msg references before the dedup-ratio tripwire is meaningful (small DBs dedup low). */
const DEDUP_TRIPWIRE_MIN_REFS = 200

/** A dedup factor below this on a non-trivial corpus suggests the volatile-key strip list is incomplete. */
const DEDUP_TRIPWIRE_FLOOR = 5

/**
 * Compute, persist (history_meta), and log the dedup ratio (total req_msg
 * references / distinct msg_blob). RFC OQ-C tripwire: a ratio near 1 on a
 * non-trivial corpus means a message is re-hashing every turn (incomplete
 * volatile-key strip → silent bloat) — surfaced here as a WARN so the failure
 * mode is detectable rather than hidden. Never throws.
 */
export function recordDedupRatio(db: Database): number {
  try {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM req_msg").get() as { n: number }).n
    const distinct = (db.prepare("SELECT COUNT(*) AS n FROM msg_blob").get() as { n: number }).n
    const ratio = distinct > 0 ? total / distinct : 0
    setMeta(db, SEARCH_INDEX_DEDUP_RATIO_KEY, ratio.toFixed(2))
    if (total >= DEDUP_TRIPWIRE_MIN_REFS && ratio < DEDUP_TRIPWIRE_FLOOR) {
      consola.warn(
        `[search-index] dedup ratio ${ratio.toFixed(1)}× is well below the expected ~40× over ${total} message refs — `
          + "the normalize-message volatile-key strip list is likely incomplete (a message is re-hashing each turn). See normalize-message.ts.",
      )
    } else if (total > 0) {
      consola.info(`[search-index] dedup ratio ${ratio.toFixed(1)}× (${total} refs → ${distinct} distinct messages)`)
    }
    return ratio
  } catch {
    return 0
  }
}

/** Cooperative stop flag (set by stopSearchIndexBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `shutdownHistory` BEFORE `closeDatabase`. */
export function stopSearchIndexBackfill(): void {
  stopRequested = true
}

/**
 * Read the stop flag through a function so the TS control-flow analyzer does not
 * narrow it to a constant `false` inside the loop — it is mutated EXTERNALLY by
 * `stopSearchIndexBackfill` (during the loop's `await`), which flow analysis can't see.
 */
function isStopRequested(): boolean {
  return stopRequested
}

/** Reset module-global backfill state (test isolation — registered in RESETTERS). */
export function resetSearchIndexBackfillForTests(): void {
  stopRequested = false
  running = false
}

interface BackfillCounts {
  built: number
  skipped: number
  errors: number
}

/** Load head rows for a batch of ids, keyed by id. */
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

/** One id-scan row: id + started_at + preview_text (NOT the head blob). */
interface ScanRow {
  id: string
  started_at: number
  preview_text: string | null
}

/**
 * Process one batch: decode each entry, recompute preview_text, build + persist
 * its search index (each entry in its own tx). Per-entry try/catch isolates a
 * single corrupt blob. Mutates `counts`.
 */
function processBatch(db: Database, scanRows: Array<ScanRow>, counts: BackfillCounts): void {
  const ids = scanRows.map((r) => r.id)
  const heads = loadHeadRows(db, ids)
  const stages = loadStageRows(db, ids)
  const checkBuilt = db.prepare("SELECT 1 AS one FROM req_msg WHERE req_id = ? LIMIT 1")
  const updatePreview = db.prepare("UPDATE entries_v2 SET preview_text = ? WHERE id = ?")

  for (const scan of scanRows) {
    try {
      // Skip already-built (resume idempotency).
      if (checkBuilt.get(scan.id)) {
        counts.skipped += 1
        continue
      }
      const head = heads.get(scan.id)
      if (!head) {
        counts.skipped += 1
        continue
      }
      const entry = assembleFullEntry(head, stages.get(scan.id) ?? [])
      const preview = extractPreviewText(entry)
      const built = buildSearchIndexForEntry(entry)
      const tx = db.transaction(() => {
        if (preview !== (scan.preview_text ?? "")) updatePreview.run(preview, scan.id)
        persistSearchIndex(db, scan.id, built)
      })
      tx()
      counts.built += 1
    } catch (err: unknown) {
      counts.errors += 1
      consola.debug(`[search-index-backfill] skipped entry ${scan.id} (undecodable)`, err)
    }
  }
}

/**
 * Build the search index + recompute preview_text for all rows, once. Guarded by
 * `search_index_version`; resumable via the cursor; cooperatively stoppable.
 * NEVER throws (background work — an escaped rejection could crash the process).
 */
export async function runSearchIndexBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, SEARCH_INDEX_VERSION_KEY) === SEARCH_INDEX_VERSION) {
      // Already complete — still log/refresh the dedup-ratio tripwire each startup.
      recordDedupRatio(db)
      return
    }

    const cursorRaw = getMeta(db, SEARCH_BACKFILL_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts: BackfillCounts = { built: 0, skipped: 0, errors: 0 }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2").get() as { n: number }).n

    // Compound (started_at, id) keyset pagination — lossless across ties: a
    // started_at cluster larger than one batch advances precisely by (ts, id).
    // Seed `lastId = ""` at the resume timestamp so the WHOLE boundary ts is
    // re-included on a restart (already-built rows de-duped by the per-entry guard).
    const scanStmt = db.prepare(
      "SELECT id, started_at, preview_text FROM entries_v2 WHERE started_at > ? OR (started_at = ? AND id > ?) ORDER BY started_at ASC, id ASC LIMIT ?",
    )
    // First query INCLUDES started_at === cursorTs via `started_at = cursorTs AND id > ""`.
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
        consola.debug("[search-index-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, SEARCH_BACKFILL_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[search-index-backfill] batch failed (db closing?) — stopping", err)
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
      // Reached the tail with no stop — mark complete and drop the cursor.
      setMeta(db, SEARCH_INDEX_VERSION_KEY, SEARCH_INDEX_VERSION)
      if (total > 0) consola.info(`[search-index-backfill] complete: built ${counts.built}, skipped ${counts.skipped}, errors ${counts.errors} (of ${total})`)
      // RFC OQ-C tripwire: surface the dedup ratio now that the index is whole.
      recordDedupRatio(db)
    }
  } catch (err: unknown) {
    consola.warn("[search-index-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
