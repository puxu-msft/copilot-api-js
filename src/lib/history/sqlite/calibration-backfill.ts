/**
 * Recoverable background backfill that SEED-CALIBRATES the size-aware factor model
 * (lib/auto-truncate/engine.ts) from existing history — the cold-start bootstrap
 * (spec §6). For every completed anthropic-messages row it pairs the REAL prompt
 * token count (the `entries_v2` usage columns) with the LOCAL gpt-tokenizer
 * estimate (recomputed from the stored wire request body) and accumulates raw
 * Σreal/Σest into the request's size bucket. When the whole table has been scanned
 * it writes each model's aggregated buckets in ONE batch via `applyBackfillBuckets`.
 *
 * Why batch-apply instead of per-row `learnCalibration` (P-B5/B6):
 *   - `learnCalibration`'s ~WEIGHT_CAP sliding window is ORDER-SENSITIVE (a large
 *     bucket decays old samples), so replaying history row-by-row is NOT
 *     idempotent — a re-run would drift. Accumulating raw Σreal/Σest and applying
 *     once is order-free and exactly reproducible.
 *   - `applyBackfillBuckets` overwrites ONLY the buckets history populated; sparse
 *     buckets keep their factory seed. It is applied at the END of the run, never
 *     mid-scan, so it never races the live CalibrationSink writing the same buckets.
 *   - Backfill is synthetic → `isLive:false` semantics: `liveSampleCount` stays 0,
 *     so `computeSafetyMargin` keeps its conservative width until real events land.
 *
 * Idempotency + recovery:
 *   - **Guard**: `history_meta(calibration_backfill_version)` short-circuits once
 *     the full scan completes — a re-run is a no-op.
 *   - **Cursor**: `history_meta(calibration_backfill_cursor)` gives a compound
 *     `(started_at, id)` keyset resume. The backfill is READ-ONLY over `entries_v2`
 *     (no marker column), so the cursor is the sole within-run progress mechanism.
 *   - **Accumulator**: `history_meta(calibration_backfill_accum)` persists the
 *     per-model bucket aggregates each batch, so a mid-run restart resumes the
 *     tok-weighted aggregate exactly rather than losing partial progress. Cleared
 *     once the run completes.
 *
 * Cooperative shutdown mirrors the sibling backfills: `stopHistoryBackgroundWork`
 * calls `stopCalibrationBackfill()` BEFORE `closeDatabase()`, and every DB op is
 * under try/catch so a close that races the loop ends gracefully. NEVER throws
 * (background work — an escaped rejection could crash the process).
 */

import consola from "consola"
import { setTimeout as sleep } from "node:timers/promises"

import type { MessagesPayload } from "~/types/api/anthropic"

import { countTotalTokens } from "~/lib/anthropic/auto-truncate"
import {
  //
  applyBackfillBuckets,
  type BackfillBucketAgg,
  BUCKET_BOUNDS,
  bucketIndexFor,
} from "~/lib/auto-truncate"
import { state } from "~/lib/state"

import type { UpstreamRequestLeg } from "../types"
import type { Database } from "./connection"
import type { StageRow } from "./serialize"

import {
  //
  CALIBRATION_BACKFILL_ACCUM_KEY,
  CALIBRATION_BACKFILL_CURSOR_KEY,
  CALIBRATION_BACKFILL_VERSION,
  CALIBRATION_BACKFILL_VERSION_KEY,
  deleteMeta,
  getMeta,
  setMeta,
} from "./meta"
import { decodeStageRows } from "./serialize"

/** Entry batch size; the loop yields to the event loop after each batch. */
const BACKFILL_BATCH_SIZE = 100

/** Number of size buckets (BUCKET_BOUNDS has one extra boundary). */
const BUCKET_COUNT = BUCKET_BOUNDS.length - 1

/** Floor on the REAL prompt tokens — below this a sample is noise, skip it. */
const REAL_FLOOR = 1000
/** Floor on the LOCAL estimate — below this the ratio is unreliable, skip it. */
const EST_FLOOR = 500

/** Cooperative stop flag (set by stopCalibrationBackfill, checked each batch). */
let stopRequested = false
/** Single-flight guard so two concurrent starts don't double-scan. */
let running = false

/** Request a graceful stop. Called by `stopHistoryBackgroundWork` BEFORE `closeDatabase`. */
export function stopCalibrationBackfill(): void {
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
export function resetCalibrationBackfillForTests(): void {
  stopRequested = false
  running = false
}

/** One id-scan row: the columns needed to compute the real prompt-token count. */
interface ScanRow {
  id: string
  started_at: number
  model: string | null
  input_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
}

/** Per-model bucket accumulators: modelId → one BackfillBucketAgg (or null) per bucket. */
type Accum = Map<string, Array<BackfillBucketAgg | null>>

interface BackfillCounts {
  aggregated: number
  skipped: number
  errors: number
}

/** Fresh 6-bucket accumulator array for one model. */
function emptyBuckets(): Array<BackfillBucketAgg | null> {
  return Array.from({ length: BUCKET_COUNT }, () => null)
}

/** Serialize the accumulator to JSON for the resumable meta row. */
function serializeAccum(accum: Accum): string {
  return JSON.stringify(Object.fromEntries(accum))
}

/** Restore the accumulator from the persisted meta row (empty on parse failure). */
function deserializeAccum(raw: string | null): Accum {
  const accum: Accum = new Map()
  if (!raw) return accum
  try {
    const obj = JSON.parse(raw) as Record<string, Array<BackfillBucketAgg | null>>
    for (const [modelId, buckets] of Object.entries(obj)) {
      // Defensive: pad/trim to the current bucket count so a stale meta shape can't
      // desync the aggregate (bounds are versioned in the engine, not here).
      const restored = emptyBuckets()
      for (let i = 0; i < Math.min(buckets.length, BUCKET_COUNT); i++) restored[i] = buckets[i] ?? null
      accum.set(modelId, restored)
    }
  } catch (err: unknown) {
    consola.debug("[calibration-backfill] accum parse failed — restarting aggregate", err)
  }
  return accum
}

/** Fold one (est, real) sample into `accum[modelId][bucket]` (incremental tok-weighted mean of est). */
function accumulate(accum: Accum, modelId: string, bucket: number, est: number, real: number): void {
  let buckets = accum.get(modelId)
  if (!buckets) {
    buckets = emptyBuckets()
    accum.set(modelId, buckets)
  }
  const agg: BackfillBucketAgg = buckets[bucket] ?? { sumReal: 0, sumEst: 0, count: 0, meanEst: 0 }
  agg.meanEst = (agg.meanEst * agg.count + est) / (agg.count + 1)
  agg.sumReal += real
  agg.sumEst += est
  agg.count += 1
  buckets[bucket] = agg
}

/**
 * Process one scan row into the accumulator (async — recomputes the local estimate
 * from the stored wire body). Returns the outcome so the caller can tally counts.
 * NEVER throws: an undecodable stage blob / missing model → the row is skipped.
 */
async function processRow(scan: ScanRow, accum: Accum, stageSelect: ReturnType<Database["prepare"]>): Promise<"aggregated" | "skipped" | "error"> {
  try {
    const modelName = scan.model
    if (!modelName) return "skipped"

    const real = (scan.input_tokens ?? 0) + (scan.cache_read ?? 0) + (scan.cache_creation ?? 0)
    if (real < REAL_FLOOR) return "skipped"

    // Reassemble the request wire body: decodeStageRows expands the request_group
    // container + double-format decompress internally — pass the raw StageRow[].
    const stageRows = stageSelect.all(scan.id) as Array<StageRow>
    const members = decodeStageRows(stageRows)
    // Take the FINAL attempt's upstream_request (the wire body paired with the
    // final upstream usage this row's real count came from).
    const upstream = members.findLast((m) => m.stage === "upstream_request")
    if (!upstream) return "skipped" // legacy row without the per-attempt upstream leg

    const leg = upstream.payload as UpstreamRequestLeg
    if (leg.format !== "anthropic-messages") return "skipped"
    const body = leg.body as MessagesPayload | undefined
    if (!body) return "skipped"

    const model = state.modelIndex.get(modelName)
    if (!model) return "skipped"

    const est = await countTotalTokens(body, model)
    if (est < EST_FLOOR) return "skipped"

    accumulate(accum, model.id, bucketIndexFor(est), est, real)
    return "aggregated"
  } catch (err: unknown) {
    // Undecodable blob / malformed leg / a DB op racing shutdown → skip this row.
    consola.debug(`[calibration-backfill] skipped entry ${scan.id}`, err)
    return "error"
  }
}

/**
 * Seed-calibrate the factor model from history, once. Guarded by
 * `calibration_backfill_version`; resumable via cursor + persisted accumulator;
 * cooperatively stoppable. NEVER throws.
 */
export async function runCalibrationBackfill(db: Database): Promise<void> {
  if (running) return
  running = true
  stopRequested = false
  try {
    if (getMeta(db, CALIBRATION_BACKFILL_VERSION_KEY) === CALIBRATION_BACKFILL_VERSION) return

    const cursorRaw = getMeta(db, CALIBRATION_BACKFILL_CURSOR_KEY)
    let cursorTs = cursorRaw === null ? 0 : Number(cursorRaw)
    if (!Number.isFinite(cursorTs)) cursorTs = 0

    // Resume the aggregate from the persisted accumulator (only meaningful when a
    // prior partial run left a cursor; a fresh run has neither).
    const accum: Accum = cursorRaw === null ? new Map() : deserializeAccum(getMeta(db, CALIBRATION_BACKFILL_ACCUM_KEY))
    const counts: BackfillCounts = { aggregated: 0, skipped: 0, errors: 0 }
    const total = (
      db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE status = 'completed' AND model LIKE 'claude%' AND input_tokens IS NOT NULL").get() as { n: number }
    ).n

    const scanStmt = db.prepare(
      "SELECT id, started_at, model, input_tokens, cache_read, cache_creation FROM entries_v2 "
        + "WHERE status = 'completed' AND model LIKE 'claude%' AND input_tokens IS NOT NULL "
        + "AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?",
    )
    const stageSelect = db.prepare("SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id = ?")

    let boundaryTs = cursorTs
    let lastId = ""

    for (;;) {
      if (isStopRequested()) break
      let scanRows: Array<ScanRow>
      try {
        scanRows = scanStmt.all(boundaryTs, boundaryTs, lastId, BACKFILL_BATCH_SIZE) as Array<ScanRow>
      } catch (err: unknown) {
        consola.debug("[calibration-backfill] scan failed (db closing?) — stopping", err)
        return
      }
      if (scanRows.length === 0) break

      try {
        for (const scan of scanRows) {
          const outcome = await processRow(scan, accum, stageSelect)
          if (outcome === "aggregated") counts.aggregated += 1
          else if (outcome === "skipped") counts.skipped += 1
          else counts.errors += 1
        }
        const last = scanRows.at(-1)
        if (last) {
          boundaryTs = last.started_at
          lastId = last.id
          // Persist cursor + accumulator together so a restart resumes both.
          setMeta(db, CALIBRATION_BACKFILL_CURSOR_KEY, String(boundaryTs))
          setMeta(db, CALIBRATION_BACKFILL_ACCUM_KEY, serializeAccum(accum))
        }
      } catch (err: unknown) {
        consola.debug("[calibration-backfill] batch failed (db closing?) — stopping", err)
        return
      }

      if (scanRows.length < BACKFILL_BATCH_SIZE) break // reached the tail
      await sleep(0)
    }

    if (!isStopRequested()) {
      // Apply each model's aggregated buckets in ONE batch (per-bucket overwrite;
      // sparse buckets keep their seed). Never mid-scan → no race with live sink.
      for (const [modelId, buckets] of accum) {
        applyBackfillBuckets(modelId, buckets)
      }
      setMeta(db, CALIBRATION_BACKFILL_VERSION_KEY, CALIBRATION_BACKFILL_VERSION)
      deleteMeta(db, CALIBRATION_BACKFILL_ACCUM_KEY)
      if (total > 0) {
        consola.info(
          `[calibration-backfill] complete: aggregated ${counts.aggregated}, skipped ${counts.skipped}, errors ${counts.errors} (of ${total}) across ${accum.size} model(s)`,
        )
      }
    }
  } catch (err: unknown) {
    consola.warn("[calibration-backfill] aborted (error — startup continues)", err)
  } finally {
    running = false
  }
}
