/**
 * Recoverable background backfill that normalizes historical `input_tokens` to
 * the canonical NET-of-cache convention (see lib/request/usage-normalize.ts).
 *
 * Pre-migration OpenAI/Responses/Gemini rows stored `input_tokens` as the
 * upstream TOTAL prompt (INCLUDING the cached-read subset), so `input_tokens`
 * overlapped `cache_read` and double-counted cached tokens in cost/aggregation.
 * This flips each such row to `input_tokens = max(0, input - cache_read -
 * cache_creation)`, in BOTH persistence sites so the list (column) and detail
 * (blob) views never diverge:
 *   - the `entries_v2.{input_tokens}` column (read by list / sessions-agg / stats), and
 *   - the `outboundResponse.usage.input_tokens` inside the blob (read by the
 *     detail page). For a FINALIZED row that lives in the standalone
 *     `outbound_response` stage row(s); for a LEGACY single-blob row it lives in
 *     the head `blob_gz`. Both are patched, layout-agnostically.
 *
 * Idempotency (CRITICAL — the subtraction is destructive, re-applying corrupts):
 *   - **Per-row marker**: `entries_v2.usage_normalized` — the scan only touches
 *     `usage_normalized = 0` rows and sets it to 1 in the SAME per-entry tx as
 *     the mutation. Every row written by the current (net-aware) producers is
 *     born 1, so a re-finalize / a new row is never re-subtracted. This marker
 *     — not the cursor — is the correctness guarantee.
 *   - **Guard**: `history_meta(usage_normalize_version)` short-circuits once the
 *     whole table is processed.
 *   - **Cursor**: `history_meta(usage_normalize_backfill_cursor)` gives
 *     within-run / cross-restart keyset resume; a compound `(started_at, id)`
 *     keyset advances losslessly across ties.
 *
 * Per-entry tx + try/catch (no-silent-data-loss): decompress/recompress happen
 * OUTSIDE the tx (CPU off the DB critical section); the tx does only the UPDATEs.
 * A row whose blob fails to decode is skipped WITHOUT marking `usage_normalized`
 * — it stays fully in the OLD convention (column + blob both un-touched, so list
 * and detail still agree) and is retried on the next full run. Anthropic rows are
 * already net → marked 1 with no data change.
 *
 * Cooperative shutdown mirrors search-index-backfill: `shutdownHistory` calls
 * `stopUsageNormalizeBackfill()` BEFORE `closeDatabase()` (this loop must NOT
 * subscribe to the late abort signal — a post-close prepare would throw), and
 * every DB op is under try/catch so a close that races the loop ends gracefully.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import { netInputTokens } from "~/lib/request/usage-normalize"

import type { Database } from "./connection"

import {
  //
  compress,
  decompress,
} from "./compression"
import {
  //
  getMeta,
  setMeta,
  USAGE_NORMALIZE_CURSOR_KEY,
  USAGE_NORMALIZE_VERSION,
  USAGE_NORMALIZE_VERSION_KEY,
} from "./meta"

/** Entry batch size; the loop yields to the event loop after each batch. */
const BACKFILL_BATCH_SIZE = 100

/** Checkpoint the WAL every N batches so a long backfill doesn't balloon `-wal`. */
const CHECKPOINT_EVERY_BATCHES = 20

/** Endpoints whose historical `input_tokens` includes the cached subset (needs subtraction). */
const OVERLAP_ENDPOINTS = new Set(["openai-chat-completions", "openai-responses", "gemini-generate-content"])

/**
 * Gemini is the one overlap endpoint with a SPLIT convention in history: the
 * STREAMING path records usage via the CC→Gemini codec, which nets
 * `promptTokenCount = max(0, prompt - cached)` (convert-response.ts, since
 * 2026-06-05) — those rows are ALREADY net and must NOT be subtracted again. The
 * NON-streaming path stored the raw total. OpenAI/Responses are uniformly total
 * across both legs → always subtracted.
 *
 * The reliable "streaming" signal is the presence of `sseEvents`, which lives in
 * exactly two entry fields (verified in context/request.ts): `entry.sseEvents`
 * (driver frame sampling → `sse_events` stage) and `entry.inboundResponse.sseEvents`
 * (the pump's `setForwardedResponse` → `inbound_response` stage). Legacy Gemini
 * streaming rows (2026-06-05..~06-20, before the driver's `setSseEvents` landed)
 * carry frames ONLY in `inbound_response`, so both must be checked — in stage form
 * (finalized rows) and inside the head blob (legacy single-blob rows). A
 * non-streaming row has neither. Biasing toward "already net" is the safe
 * direction: a mislabeled total row merely stays total; a net row is never
 * corrupted.
 */
function hasSseEvents(value: { sseEvents?: unknown; inboundResponse?: { sseEvents?: unknown } } | null): boolean {
  if (!value) return false
  return Boolean(value.sseEvents ?? value.inboundResponse?.sseEvents)
}

function isGeminiAlreadyNet(db: Database, id: string): boolean {
  // Fast path: a top-level / per-attempt sse_events stage (driver-era streaming).
  if (db.prepare("SELECT 1 AS one FROM entry_stages WHERE entry_id = ? AND stage = 'sse_events' LIMIT 1").get(id)) return true
  // The forwarded frames of a pre-driver streaming row live in the inbound_response stage.
  const ir = db.prepare("SELECT blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'inbound_response' LIMIT 1").get(id) as
    | { blob_gz: Uint8Array }
    | undefined
  if (ir) {
    try {
      if ((decompress(ir.blob_gz) as { sseEvents?: unknown } | null)?.sseEvents) return true
    } catch {
      // Undecodable inbound_response → fall through (the caller net-izes, but its
      // outbound_response decode would fail too → skipped without marking).
    }
  }
  // Any stage at all → this is a stage-split row; neither sse signal above fired
  // → the non-streaming (total) leg → subtract.
  if (db.prepare("SELECT 1 AS one FROM entry_stages WHERE entry_id = ? LIMIT 1").get(id)) return false
  // Legacy single-blob row: sseEvents (if any) lives inside the head blob, in either
  // the top-level `sseEvents` or `inboundResponse.sseEvents` field.
  try {
    const head = db.prepare("SELECT blob_gz FROM entries_v2 WHERE id = ?").get(id) as { blob_gz: Uint8Array } | undefined
    if (!head) return false
    return hasSseEvents(decompress(head.blob_gz) as { sseEvents?: unknown; inboundResponse?: { sseEvents?: unknown } } | null)
  } catch {
    return false
  }
}

/** Cooperative stop flag (set by stopUsageNormalizeBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `shutdownHistory` BEFORE `closeDatabase`. */
export function stopUsageNormalizeBackfill(): void {
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
export function resetUsageNormalizeBackfillForTests(): void {
  stopRequested = false
  running = false
}

interface BackfillCounts {
  normalized: number
  markedOnly: number
  errors: number
}

/** One id-scan row: the small columns needed to decide + compute net (NOT the blob). */
interface ScanRow {
  id: string
  started_at: number
  endpoint: string | null
  input_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
}

/** A blob rewrite queued for the per-entry tx (compression already done, off-tx). */
interface BlobRewrite {
  /** entries_v2 head blob when `stage` is undefined; else the entry_stages row. */
  stage?: string
  attemptIndex?: number
  blob: Uint8Array
}

/** Minimal shape of the outboundResponse object stored in the outbound_response stage / legacy blob. */
interface OutboundResponseShape {
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

/** Patch `usage.input_tokens` → net (computed from THIS object's own fields — never a shared reference). */
function netizeUsageInPlace(usage: NonNullable<OutboundResponseShape["usage"]>): boolean {
  if (typeof usage.input_tokens !== "number") return false
  const net = netInputTokens(usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0)
  if (net === usage.input_tokens) return false
  usage.input_tokens = net
  return true
}

/**
 * Prepare the blob rewrites for one overlap-convention entry (decompress + patch
 * + recompress, all OFF-tx). Returns the queued rewrites, or throws if a blob is
 * undecodable (the caller then skips the row WITHOUT marking it normalized).
 *
 * Layout-agnostic: a FINALIZED row's usage lives in `outbound_response` stage
 * row(s); a LEGACY single-blob row's lives in the head blob. We patch whichever
 * carries it — the head blob of a finalized row never holds `outboundResponse`
 * (STAGE_TOP_KEYS strips it), so we only decode it when there are no stage rows.
 */
function prepareBlobRewrites(headBlob: Uint8Array | undefined, stageRows: Array<{ attempt_index: number; blob_gz: Uint8Array }>): Array<BlobRewrite> {
  const rewrites: Array<BlobRewrite> = []

  if (stageRows.length > 0) {
    // Finalized: patch each outbound_response stage row's own usage.
    for (const s of stageRows) {
      const payload = decompress(s.blob_gz) as OutboundResponseShape | null
      if (payload?.usage && netizeUsageInPlace(payload.usage)) {
        rewrites.push({ stage: "outbound_response", attemptIndex: s.attempt_index, blob: compress(payload) })
      }
    }
    return rewrites
  }

  // No outbound_response stage row → legacy single-blob row (head blob is the
  // full entry) or a finalized no-response row (head blob has no outboundResponse).
  if (headBlob) {
    const full = decompress(headBlob) as { outboundResponse?: OutboundResponseShape } | null
    const usage = full?.outboundResponse?.usage
    if (usage && netizeUsageInPlace(usage)) {
      rewrites.push({ blob: compress(full) })
    }
  }
  return rewrites
}

/**
 * Process one batch: for each scan row, normalize (anthropic → mark only; overlap
 * endpoints → net-ize column + blob(s)) in its own tx. Per-entry try/catch: a
 * bad blob leaves the row at usage_normalized=0 for a later retry. Mutates counts.
 */
function processBatch(db: Database, scanRows: Array<ScanRow>, counts: BackfillCounts): void {
  const markStmt = db.prepare("UPDATE entries_v2 SET usage_normalized = 1 WHERE id = ?")
  const setColStmt = db.prepare("UPDATE entries_v2 SET input_tokens = ?, usage_normalized = 1 WHERE id = ?")
  const setHeadBlobStmt = db.prepare("UPDATE entries_v2 SET blob_gz = ? WHERE id = ?")
  const setStageBlobStmt = db.prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = ? AND attempt_index = ?")
  const stageSelect = db.prepare("SELECT attempt_index, blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'outbound_response'")
  const headSelect = db.prepare("SELECT blob_gz FROM entries_v2 WHERE id = ?")

  for (const scan of scanRows) {
    try {
      if (!scan.endpoint || !OVERLAP_ENDPOINTS.has(scan.endpoint)) {
        // Anthropic (or unknown) rows are already net — just mark, no data change.
        markStmt.run(scan.id)
        counts.markedOnly += 1
        continue
      }

      // Gemini STREAMING rows are already net (codec-nudged promptTokenCount) — mark
      // only, NEVER re-subtract. Non-streaming Gemini + all OpenAI/Responses = total.
      if (scan.endpoint === "gemini-generate-content" && isGeminiAlreadyNet(db, scan.id)) {
        markStmt.run(scan.id)
        counts.markedOnly += 1
        continue
      }

      // Column net (from the column's OWN values — independent of the blob's).
      const colNet = scan.input_tokens === null ? null : netInputTokens(scan.input_tokens, scan.cache_read ?? 0, scan.cache_creation ?? 0)

      // Decompress + patch blob(s) OFF-tx. Fetch stage rows first; only decode the
      // head blob when there are none (legacy / no-response layout).
      const stageRows = stageSelect.all(scan.id) as Array<{ attempt_index: number; blob_gz: Uint8Array }>
      const headBlob = stageRows.length === 0 ? (headSelect.get(scan.id) as { blob_gz: Uint8Array } | undefined)?.blob_gz : undefined
      const rewrites = prepareBlobRewrites(headBlob, stageRows)

      const tx = db.transaction(() => {
        if (colNet !== null && colNet !== scan.input_tokens) setColStmt.run(colNet, scan.id)
        else markStmt.run(scan.id)
        for (const rw of rewrites) {
          if (rw.stage) setStageBlobStmt.run(rw.blob, scan.id, rw.stage, rw.attemptIndex)
          else setHeadBlobStmt.run(rw.blob, scan.id)
        }
      })
      tx()
      counts.normalized += 1
    } catch (err: unknown) {
      // Undecodable blob (or a DB op raced shutdown). Leave usage_normalized=0 —
      // the row stays fully in the OLD convention (column + blob both untouched,
      // so list/detail still agree) and is retried on the next full run.
      counts.errors += 1
      consola.debug(`[usage-normalize-backfill] skipped entry ${scan.id}`, err)
    }
  }
}

/**
 * Normalize every historical row's usage to the net convention, once. Guarded by
 * `usage_normalize_version`; resumable via the cursor; cooperatively stoppable.
 * NEVER throws (background work — an escaped rejection could crash the process).
 */
export async function runUsageNormalizeBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, USAGE_NORMALIZE_VERSION_KEY) === USAGE_NORMALIZE_VERSION) return

    const cursorRaw = getMeta(db, USAGE_NORMALIZE_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts: BackfillCounts = { normalized: 0, markedOnly: 0, errors: 0 }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE usage_normalized = 0").get() as { n: number }).n

    // Compound (started_at, id) keyset over the NOT-yet-normalized rows. As rows
    // flip to usage_normalized=1 they drop out of the predicate, so the cursor +
    // marker together are lossless across ties and restarts.
    const scanStmt = db.prepare(
      "SELECT id, started_at, endpoint, input_tokens, cache_read, cache_creation FROM entries_v2 "
        + "WHERE usage_normalized = 0 AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
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
        consola.debug("[usage-normalize-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, USAGE_NORMALIZE_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[usage-normalize-backfill] batch failed (db closing?) — stopping", err)
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
      setMeta(db, USAGE_NORMALIZE_VERSION_KEY, USAGE_NORMALIZE_VERSION)
      if (total > 0) {
        consola.info(`[usage-normalize-backfill] complete: normalized ${counts.normalized}, marked ${counts.markedOnly}, errors ${counts.errors} (of ${total})`)
      }
    }
  } catch (err: unknown) {
    consola.warn("[usage-normalize-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
