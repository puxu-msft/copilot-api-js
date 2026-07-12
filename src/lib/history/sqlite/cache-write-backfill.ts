/**
 * Recoverable cache-write backfill: re-derive `cache_creation_input_tokens` (and
 * fix `input_tokens`) for historical STREAMING OpenAI-family rows that were written
 * BEFORE fix-forward captured GHC's `cache_write_tokens`.
 *
 * Provenance / why this shape (docs/spec/2026-07-12-ghc-usage-details.md §6):
 *   - **Source = raw upstream frames, never the stored column (C2).** The stored
 *     `input_tokens` on these rows is already net-of-CACHED (`prompt − cached`,
 *     written by the pre-fix-forward producer / usage-normalize-backfill). Applying
 *     `netInputTokens` to it again would DOUBLE-subtract and silently corrupt the
 *     count. Instead we read the RAW `prompt/cached/cache_write` out of the
 *     `sse_events` frames and recompute the WHOLE split from scratch:
 *     `input = prompt − cached − cache_write` (subset branch, PoC conclusion),
 *     `cache_read = cached`, `cache_creation = cache_write`.
 *   - **Streaming-only.** Non-streaming historical rows never stored the raw
 *     upstream body (fix-forward's G6 rawBody starts fresh), so there is no source;
 *     they are marked-skipped. New rows are born `cache_write_backfilled=1`.
 *   - **Per-endpoint frame shape (M3).** chat/gemini frames carry usage at
 *     `usage.prompt_tokens(+prompt_tokens_details)`; responses frames at
 *     `response.usage.input_tokens(+input_tokens_details)`.
 *   - **Runs AFTER legacy-stage-backfill** (state.ts chain), so every row is in the
 *     new `upstream_response` stage layout; a legacy single-blob fallback is kept
 *     defensively.
 *
 * Idempotency rests on the per-row `cache_write_backfilled` marker (the recompute is
 * destructive-if-repeated-wrongly, but reading from raw frames makes a re-run a
 * no-op). NEVER throws (background work). Independent oracle: the subset identity
 * `input + cache_read + cache_creation === prompt` — a row that fails it is left
 * unmarked (counted as an error) rather than written with a wrong split.
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import type { Database } from "./connection"

import { compress, decompress } from "./compression"
import {
  //
  CACHE_WRITE_BACKFILL_CURSOR_KEY,
  CACHE_WRITE_BACKFILL_VERSION,
  CACHE_WRITE_BACKFILL_VERSION_KEY,
  getMeta,
  setMeta,
} from "./meta"

const BACKFILL_BATCH_SIZE = 100
const CHECKPOINT_EVERY_BATCHES = 20

/** OpenAI-family endpoints whose historical streaming rows may carry a droppable cache_write. */
const TARGET_ENDPOINTS = new Set(["openai-chat-completions", "openai-responses", "gemini-generate-content"])

/** Cooperative stop flag (set by stopCacheWriteBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `shutdownHistory` BEFORE `closeDatabase`. */
export function stopCacheWriteBackfill(): void {
  stopRequested = true
}

/** Read the stop flag through a function so TS control-flow analysis doesn't narrow it. */
function isStopRequested(): boolean {
  return stopRequested
}

/** Reset module-global backfill state (test isolation — registered in RESETTERS). */
export function resetCacheWriteBackfillForTests(): void {
  stopRequested = false
  running = false
}

interface BackfillCounts {
  patched: number
  markedOnly: number
  errors: number
}

interface ScanRow {
  id: string
  started_at: number
  endpoint: string | null
}

/** The raw usage split parsed out of ONE upstream frame (endpoint-normalized). */
interface RawSplit {
  prompt: number
  cached: number
  cacheWrite: number
}

/** SSE frame record shape (subset — only `raw` is needed here). */
interface FrameRecord {
  raw?: string
}

/**
 * Parse ONE upstream frame's JSON and pull the usage split, endpoint-aware.
 * Returns undefined when the frame has no usage object. chat/gemini use
 * `usage.prompt_tokens(+prompt_tokens_details)`; responses use
 * `response.usage.input_tokens(+input_tokens_details)` (M3).
 */
function splitFromFrame(raw: string, endpoint: string): RawSplit | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)

  if (endpoint === "openai-responses") {
    const u = (parsed as { response?: { usage?: { input_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } } } })?.response?.usage
    if (!u || u.input_tokens === undefined) return undefined
    return { prompt: num(u.input_tokens), cached: num(u.input_tokens_details?.cached_tokens), cacheWrite: num(u.input_tokens_details?.cache_write_tokens) }
  }
  // chat-completions + gemini (CC-shaped upstream frame)
  const u = (parsed as { usage?: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } } })?.usage
  if (!u || u.prompt_tokens === undefined) return undefined
  return { prompt: num(u.prompt_tokens), cached: num(u.prompt_tokens_details?.cached_tokens), cacheWrite: num(u.prompt_tokens_details?.cache_write_tokens) }
}

/** Scan all frames, return the split from the LAST frame that carries a usage object (M2). */
function splitFromFrames(frames: Array<FrameRecord>, endpoint: string): RawSplit | undefined {
  let found: RawSplit | undefined
  for (const f of frames) {
    if (!f.raw) continue
    const s = splitFromFrame(f.raw, endpoint)
    if (s) found = s
  }
  return found
}

/**
 * Read the upstream-original SSE frames for a row. PRIMARY source (post-migration
 * layout, which is ALL rows this backfill sees — it runs after legacy-stage-backfill
 * which DELETEs old stages and re-serializes): the `upstream_response` stage (max
 * attempt_index = the final attempt, aligned with the column's derive source
 * `attempts.at(-1).upstreamResponse`) whose payload carries `sseEvents` NESTED (see
 * serialize.ts extractStagePayloads / buildUpstreamResponseLeg). Fallbacks for
 * unmigrated rows: a standalone `sse_events` stage (attempt_index -1), then the
 * legacy single-blob head's `sseEvents`. Returns undefined when there is no source.
 */
function readUpstreamFrames(db: Database, id: string, headBlob: Uint8Array | undefined): Array<FrameRecord> | undefined {
  // PRIMARY: the max-attempt_index upstream_response stage's nested sseEvents.
  const ur = db.prepare("SELECT blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'upstream_response' ORDER BY attempt_index DESC LIMIT 1").get(id) as
    | { blob_gz: Uint8Array }
    | undefined
  if (ur) {
    const payload = decompress(ur.blob_gz) as { sseEvents?: unknown } | null
    if (Array.isArray(payload?.sseEvents)) return payload.sseEvents as Array<FrameRecord>
  }
  // FALLBACK (unmigrated): a standalone sse_events stage (final-attempt frames).
  const stage = db.prepare("SELECT blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'sse_events' AND attempt_index = -1").get(id) as { blob_gz: Uint8Array } | undefined
  if (stage) {
    const payload = decompress(stage.blob_gz)
    if (Array.isArray(payload)) return payload as Array<FrameRecord>
  }
  // FALLBACK (legacy single-blob): sseEvents inside the head blob.
  if (headBlob) {
    const full = decompress(headBlob) as { sseEvents?: unknown } | null
    if (Array.isArray(full?.sseEvents)) return full.sseEvents as Array<FrameRecord>
  }
  return undefined
}

/** A usage object we patch in place inside a blob. */
interface PatchableUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Apply the recomputed split to a usage object in place. */
function applySplit(usage: PatchableUsage, input: number, cacheRead: number, cacheCreation: number): void {
  usage.input_tokens = input
  if (cacheRead > 0) usage.cache_read_input_tokens = cacheRead
  usage.cache_creation_input_tokens = cacheCreation
}

/** A blob rewrite queued for the per-entry tx (compression already done, off-tx). */
interface BlobRewrite {
  stage?: string
  attemptIndex?: number
  blob: Uint8Array
}

/**
 * Prepare blob rewrites carrying the recomputed split. New layout: the max
 * attempt_index `upstream_response` stage (the final attempt whose usage feeds the
 * column). Legacy single-blob: the head's `outboundResponse.usage` + per-attempt
 * `response.usage`. Returns the queued rewrites (empty if nothing carried usage).
 */
function prepareBlobRewrites(db: Database, id: string, headBlob: Uint8Array | undefined, input: number, cacheRead: number, cacheCreation: number): Array<BlobRewrite> {
  const rewrites: Array<BlobRewrite> = []
  const stageRow = db.prepare("SELECT attempt_index, blob_gz FROM entry_stages WHERE entry_id = ? AND stage = 'upstream_response' ORDER BY attempt_index DESC LIMIT 1").get(id) as
    | { attempt_index: number; blob_gz: Uint8Array }
    | undefined
  if (stageRow) {
    const payload = decompress(stageRow.blob_gz) as { usage?: PatchableUsage } | null
    if (payload?.usage) {
      applySplit(payload.usage, input, cacheRead, cacheCreation)
      rewrites.push({ stage: "upstream_response", attemptIndex: stageRow.attempt_index, blob: compress(payload) })
    }
    return rewrites
  }
  // Legacy single-blob fallback.
  if (headBlob) {
    const full = decompress(headBlob) as { outboundResponse?: { usage?: PatchableUsage }; attempts?: Array<{ response?: { usage?: PatchableUsage } }> } | null
    let changed = false
    if (full?.outboundResponse?.usage) {
      applySplit(full.outboundResponse.usage, input, cacheRead, cacheCreation)
      changed = true
    }
    for (const a of full?.attempts ?? []) {
      if (a.response?.usage) {
        applySplit(a.response.usage, input, cacheRead, cacheCreation)
        changed = true
      }
    }
    if (changed && full) rewrites.push({ blob: compress(full) })
  }
  return rewrites
}

/**
 * Process one batch. Per-entry try/catch: a bad blob leaves the row unmarked for a
 * later retry. Mutates `counts`.
 */
function processBatch(db: Database, scanRows: Array<ScanRow>, counts: BackfillCounts): void {
  const markStmt = db.prepare("UPDATE entries_v2 SET cache_write_backfilled = 1 WHERE id = ?")
  const setColStmt = db.prepare("UPDATE entries_v2 SET input_tokens = ?, cache_read = ?, cache_creation = ?, cache_write_backfilled = 1 WHERE id = ?")
  const setStageBlobStmt = db.prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = ? AND attempt_index = ?")
  const setHeadBlobStmt = db.prepare("UPDATE entries_v2 SET blob_gz = ? WHERE id = ?")
  const headSelect = db.prepare("SELECT blob_gz FROM entries_v2 WHERE id = ?")

  for (const scan of scanRows) {
    try {
      const endpoint = scan.endpoint ?? ""
      const headBlob = (headSelect.get(scan.id) as { blob_gz: Uint8Array } | undefined)?.blob_gz
      const frames = readUpstreamFrames(db, scan.id, headBlob)
      const split = frames ? splitFromFrames(frames, endpoint) : undefined

      // No streaming source, or the frame carried no cache_write → nothing to
      // backfill; mark so we don't re-scan (verified: no cache write for this row).
      if (!split || split.cacheWrite <= 0) {
        markStmt.run(scan.id)
        counts.markedOnly += 1
        continue
      }

      // Whole recompute from RAW frame values (subset branch) — never touches the
      // already-net stored column (C2).
      const input = Math.max(0, split.prompt - split.cached - split.cacheWrite)
      // Independent oracle: subset identity must hold, else skip WITHOUT marking.
      if (input + split.cached + split.cacheWrite !== split.prompt) {
        counts.errors += 1
        consola.debug(`[cache-write-backfill] oracle mismatch, skipped entry ${scan.id}`)
        continue
      }

      const rewrites = prepareBlobRewrites(db, scan.id, headBlob, input, split.cached, split.cacheWrite)
      const tx = db.transaction(() => {
        setColStmt.run(input, split.cached > 0 ? split.cached : null, split.cacheWrite, scan.id)
        for (const rw of rewrites) {
          if (rw.stage) setStageBlobStmt.run(rw.blob, scan.id, rw.stage, rw.attemptIndex)
          else setHeadBlobStmt.run(rw.blob, scan.id)
        }
      })
      tx()
      counts.patched += 1
    } catch (err: unknown) {
      counts.errors += 1
      consola.debug(`[cache-write-backfill] skipped entry ${scan.id}`, err)
    }
  }
}

/**
 * Backfill `cache_creation` (from cache_write) for historical streaming OpenAI-family
 * rows, once. Guarded by `cache_write_backfill_version`; resumable via the cursor;
 * cooperatively stoppable. NEVER throws.
 */
export async function runCacheWriteBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, CACHE_WRITE_BACKFILL_VERSION_KEY) === CACHE_WRITE_BACKFILL_VERSION) return

    const cursorRaw = getMeta(db, CACHE_WRITE_BACKFILL_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    const counts: BackfillCounts = { patched: 0, markedOnly: 0, errors: 0 }
    const endpointList = [...TARGET_ENDPOINTS].map((e) => `'${e}'`).join(",")
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE cache_write_backfilled = 0 AND endpoint IN (${endpointList})`).get() as { n: number }).n

    // Compound (started_at, id) keyset over the not-yet-backfilled TARGET rows. As
    // rows flip to cache_write_backfilled=1 they drop out of the predicate.
    const scanStmt = db.prepare(
      `SELECT id, started_at, endpoint FROM entries_v2 WHERE cache_write_backfilled = 0 AND endpoint IN (${endpointList}) `
        + "AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
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
        consola.debug("[cache-write-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        processBatch(db, scanRows, counts)
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          setMeta(db, CACHE_WRITE_BACKFILL_CURSOR_KEY, String(boundaryTs))
        }
      } catch (err: unknown) {
        consola.debug("[cache-write-backfill] batch failed (db closing?) — stopping", err)
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
      if (scanRows.length < BACKFILL_BATCH_SIZE) break
      await sleep(0)
    }

    if (!isStopRequested()) {
      setMeta(db, CACHE_WRITE_BACKFILL_VERSION_KEY, CACHE_WRITE_BACKFILL_VERSION)
      if (total > 0) {
        consola.info(`[cache-write-backfill] complete: patched ${counts.patched}, marked ${counts.markedOnly}, errors ${counts.errors} (of ${total})`)
      }
    }
  } catch (err: unknown) {
    // Never let a background rejection escape (→ unhandledRejection → crash).
    consola.warn("[cache-write-backfill] unexpected error", err)
  } finally {
    running = false
  }
}
