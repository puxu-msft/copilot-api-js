/**
 * Per-model token-count calibration: a size-aware factor model that maps a local
 * gpt-tokenizer estimate to the upstream's real input-token count, learned from
 * live traffic (success + 400 legs) and a factory seed. Consumed for honest local
 * token counting (count-tokens fallback + debug probe).
 */

import consola from "consola"
import fs from "node:fs/promises"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "~/lib/atomic-fs"
import { PATHS } from "~/lib/config/paths"

// ============================================================================
// Learned Limits (per-model, with calibration)
// ============================================================================

export const BUCKET_BOUNDS: ReadonlyArray<number> = [0, 15_000, 30_000, 60_000, 120_000, 240_000, Infinity]
export const WEIGHT_CAP = 2000
export const FACTOR_BOUNDS_VERSION = 1
const CALIBRATION_MIN = 0.5
const CALIBRATION_MAX = 3.0

/** One size bucket's running tok-weighted calibration aggregate. */
export interface FactorBucket {
  sumReal: number
  sumEst: number
  sampleCount: number
  meanEst: number
}
/** Per-model size-aware factor model: one aggregate per size bucket. */
export interface FactorModel {
  boundsVersion: number
  buckets: Array<FactorBucket>
}
/** Per-model learned limits with size-aware tokenizer calibration */
export interface ModelLimits {
  factorModel: FactorModel
  /** LIVE learning events only (success + 400); seed/backfill do NOT bump it.
   *  A confidence signal surfaced by the debug calibration probe. */
  liveSampleCount: number
  updatedAt: number
}

export function emptyFactorModel(): FactorModel {
  return {
    boundsVersion: FACTOR_BOUNDS_VERSION,
    buckets: Array.from({ length: BUCKET_BOUNDS.length - 1 }, () => ({ sumReal: 0, sumEst: 0, sampleCount: 0, meanEst: 0 })),
  }
}

export function bucketIndexFor(est: number): number {
  for (let i = 0; i < BUCKET_BOUNDS.length - 1; i++) {
    if (est >= BUCKET_BOUNDS[i] && est < BUCKET_BOUNDS[i + 1]) return i
  }
  return BUCKET_BOUNDS.length - 2
}

const learnedLimits = new Map<string, ModelLimits>()

/** Get learned limits for a model (including calibration data) */
export function getLearnedLimits(modelId: string): ModelLimits | undefined {
  return learnedLimits.get(modelId)
}

/** Reset all dynamic limits (for testing) */
export function resetAllLimitsForTesting(): void {
  learnedLimits.clear()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}

// ============================================================================
// Size-Aware Calibration (per-bucket sliding tok-weighted mean)
// ============================================================================

/** Read a bucket's factor = clamp(Σreal/Σest). Undefined when the bucket is empty. */
function bucketFactor(b: FactorBucket): number | undefined {
  if (b.sampleCount === 0 || b.sumEst <= 0) return undefined
  return Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, b.sumReal / b.sumEst))
}

/** size-aware factor via log-linear interpolation between populated bucket anchors
 *  (anchor x = bucket.meanEst, y = bucketFactor). Empty model → 1.0 (no-op). */
export function factorAt(modelId: string, est: number): number {
  const limits = learnedLimits.get(modelId)
  if (!limits) return 1.0
  const anchors: Array<{ x: number; y: number }> = []
  for (const b of limits.factorModel.buckets) {
    const y = bucketFactor(b)
    if (y !== undefined && b.meanEst > 0) anchors.push({ x: b.meanEst, y })
  }
  if (anchors.length === 0) return 1.0
  anchors.sort((a, b) => a.x - b.x)
  const first = anchors[0]
  const last = anchors.at(-1) ?? first
  if (est <= first.x) return first.y
  if (est >= last.x) return last.y
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]
    const b = anchors[i + 1]
    if (est >= a.x && est <= b.x) {
      const t = (Math.log(est) - Math.log(a.x)) / (Math.log(b.x) - Math.log(a.x))
      return a.y + t * (b.y - a.y)
    }
  }
  return last.y
}

export const DEFAULT_FACTOR_SEED: Record<string, Array<{ factor: number; meanEst: number } | null>> = {
  "claude-opus-4.8": [
    null,
    { factor: 1.284, meanEst: 23_877 },
    { factor: 1.313, meanEst: 48_784 },
    { factor: 1.434, meanEst: 85_238 },
    { factor: 1.625, meanEst: 163_889 },
    { factor: 1.826, meanEst: 333_152 },
  ],
}

/** Synthetic seed weight — small enough that real live/backfill data dominates
 *  within a few hundred samples, non-zero so the anchor exists pre-backfill. */
const SEED_WEIGHT = 500

export function seedFactorModel(modelId: string): FactorModel {
  const fm = emptyFactorModel()
  // Record index access is typed non-undefined here, but an unknown modelId is a
  // real runtime case — cast so the guard below is honest, not "unnecessary".
  const seed = DEFAULT_FACTOR_SEED[modelId] as Array<{ factor: number; meanEst: number } | null> | undefined
  if (!seed) return fm
  for (const [i, s] of seed.entries()) {
    if (!s) continue
    fm.buckets[i] = { sumEst: SEED_WEIGHT * s.meanEst, sumReal: SEED_WEIGHT * s.meanEst * s.factor, sampleCount: SEED_WEIGHT, meanEst: s.meanEst }
  }
  return fm
}

/** Migration helper: lift a v1 scalar factor into the top size bucket only,
 *  so an unseeded legacy model keeps its learned factor as a single anchor. */
function seedTopBucketOnly(factor: number): FactorModel {
  const fm = emptyFactorModel()
  const top = fm.buckets.length - 1
  fm.buckets[top] = { sumEst: SEED_WEIGHT * 300_000, sumReal: SEED_WEIGHT * 300_000 * factor, sampleCount: SEED_WEIGHT, meanEst: 300_000 }
  return fm
}

export function ensureModelLimits(modelId: string): ModelLimits {
  let limits = learnedLimits.get(modelId)
  if (!limits) {
    limits = { factorModel: seedFactorModel(modelId), liveSampleCount: 0, updatedAt: Date.now() }
    learnedLimits.set(modelId, limits)
  }
  return limits
}

/** Feed one (localEstimate, realTokens) sample into its size bucket as a
 *  ~WEIGHT_CAP sliding tok-weighted mean. Success + 400 legs share this. */
export function learnCalibration(modelId: string, localEstimate: number, realTokens: number, opts: { isLive: boolean }): void {
  if (localEstimate <= 0 || realTokens <= 0) return
  const limits = ensureModelLimits(modelId)
  const b = limits.factorModel.buckets[bucketIndexFor(localEstimate)]
  const effWeight = b.sampleCount
  if (effWeight >= WEIGHT_CAP) {
    const decay = WEIGHT_CAP / (WEIGHT_CAP + 1)
    b.sumReal *= decay
    b.sumEst *= decay
  }
  b.sumReal += realTokens
  b.sumEst += localEstimate
  const w = Math.min(effWeight, WEIGHT_CAP)
  b.meanEst = (b.meanEst * w + localEstimate) / (w + 1)
  b.sampleCount = Math.min(b.sampleCount + 1, WEIGHT_CAP)
  if (opts.isLive) limits.liveSampleCount++
  limits.updatedAt = Date.now()
  schedulePersist()
}

/** Apply size-aware calibration to a gpt-tokenizer estimate. Signature unchanged;
 *  an unlearned/empty model returns the estimate unchanged (factorAt → 1.0). */
export function calibrate(modelId: string, gptEstimate: number): number {
  return Math.ceil(gptEstimate * factorAt(modelId, gptEstimate))
}

/** Batch aggregate for one size bucket (raw Σreal/Σest, not yet capped/scaled). */
export interface BackfillBucketAgg {
  sumReal: number
  sumEst: number
  count: number
  meanEst: number
}

/**
 * Overwrite selected buckets from batch aggregates (history backfill). Per-bucket:
 * only buckets present (non-null, non-empty) in `agg` are replaced — empty/sparse
 * buckets keep their factory seed (P-B6), so a bucket the history never populated
 * still has its prior. Weight is capped at WEIGHT_CAP (Σreal/Σest scaled down
 * proportionally) so a huge backfilled count can't freeze the sliding window
 * against later LIVE learning (P-B5). Backfill is NOT live: `liveSampleCount` is
 * untouched, so the liveSampleCount confidence signal stays honest until real
 * success/400 events arrive. Called once at the END of a run (never mid-scan). The
 * per-bucket overwrite DISCARDS any live samples the CalibrationSink learned into
 * these same buckets during the scan window — a bounded one-time cold-start artifact
 * (a handful of samples, re-learned by the live sink immediately; negligible margin
 * effect). Since `liveSampleCount` is not rewritten here, it may briefly read a touch
 * higher than the overwritten bucket sums reflect until the next live sample re-syncs
 * them (self-healing, not a leak).
 */
export function applyBackfillBuckets(modelId: string, agg: Array<BackfillBucketAgg | null>): void {
  const limits = ensureModelLimits(modelId)
  for (const [i, a] of agg.entries()) {
    if (!a || a.count === 0 || a.sumEst <= 0) continue
    const scale = a.count > WEIGHT_CAP ? WEIGHT_CAP / a.count : 1
    limits.factorModel.buckets[i] = {
      sumReal: a.sumReal * scale,
      sumEst: a.sumEst * scale,
      sampleCount: Math.min(a.count, WEIGHT_CAP),
      meanEst: a.meanEst,
    }
  }
  limits.updatedAt = Date.now()
  schedulePersist()
}

// ============================================================================
// Limit Persistence
// ============================================================================

interface LearnedLimitsFile {
  version: 2
  limits: Record<string, ModelLimits>
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 5000

/**
 * Override the learned-limits persistence path. Tests inject a temp file here so
 * the engine never reads/writes the real `PATHS.LEARNED_LIMITS`. `undefined`
 * restores the default. Mirrors `_setRequestTelemetryFilePathForTests`.
 */
let learnedLimitsPath: string | undefined
export function setLearnedLimitsPathForTests(path: string | undefined): void {
  learnedLimitsPath = path
}

/** Schedule an async write of learned limits (debounced) */
export function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistLimits()
  }, PERSIST_DEBOUNCE_MS)
}

/** Debounce for persist-failure logging — warn once, reset on a successful write. */
let persistFailureLogged = false

/**
 * Write learned limits to disk. Serialized + atomic — see `~/lib/atomic-fs`.
 *
 * Without serialization, debounce-fired writes can race a shutdown-fired
 * write and the older snapshot can rename last, losing newer learned limits.
 * Without atomicity, a crash mid-write leaves truncated JSON and the loader's
 * `catch{}` silently zeroes every model's learned token limit — each model
 * then needs one extra failed round-trip to relearn its cap.
 */

export const persistLimits = createSerializedAsyncFn(async () => {
  if (learnedLimits.size === 0) return
  const data: LearnedLimitsFile = { version: 2, limits: Object.fromEntries(learnedLimits) }
  try {
    await atomicWriteJson(learnedLimitsPath ?? PATHS.LEARNED_LIMITS, data)
    persistFailureLogged = false
  } catch (err) {
    // Re-learnable on next error, but persistent ENOSPC / permission failures
    // still warrant a trail. Warn once until a write recovers (avoids repeating
    // on every subsequent learning event while the disk stays broken).
    if (!persistFailureLogged) {
      persistFailureLogged = true
      consola.warn("[AutoTruncate] persist failed (learned limits will re-learn but won't survive restart):", err)
    }
  }
})

/** Load previously persisted limits from disk (called at startup) */
export async function loadPersistedLimits(): Promise<void> {
  try {
    const raw = await fs.readFile(learnedLimitsPath ?? PATHS.LEARNED_LIMITS, "utf8")
    const data = JSON.parse(raw) as { version: number; limits: Record<string, unknown> }
    if (data.version === 2) {
      for (const [modelId, lim] of Object.entries(data.limits as Record<string, Partial<ModelLimits>>)) {
        // boundsVersion 不匹配（或缺 factorModel）→ 丢桶重 seed（保留 liveSampleCount）。
        // 旧 v2 的 tokenLimit 字段（截断遗留）读时忽略。
        const persisted = lim.factorModel
        const fm = persisted && persisted.boundsVersion === FACTOR_BOUNDS_VERSION ? persisted : seedFactorModel(modelId)
        learnedLimits.set(modelId, {
          factorModel: fm,
          liveSampleCount: lim.liveSampleCount ?? 0,
          updatedAt: lim.updatedAt ?? Date.now(),
        })
      }
    } else if (data.version === 1) {
      for (const [modelId, lim] of Object.entries(data.limits as Record<string, { calibrationFactor: number; sampleCount?: number }>)) {
        const fm = Object.hasOwn(DEFAULT_FACTOR_SEED, modelId) ? seedFactorModel(modelId) : seedTopBucketOnly(lim.calibrationFactor)
        learnedLimits.set(modelId, {
          factorModel: fm,
          liveSampleCount: lim.sampleCount ?? 0,
          updatedAt: Date.now(),
        })
      }
    }
    // version 0/unknown falls through — no persisted entries loaded, but seed
    // materialization below still runs (fresh-install parity).
    if (learnedLimits.size > 0) {
      consola.info(`[AutoTruncate] Loaded learned limits for ${learnedLimits.size} model(s)`)
    }
  } catch (err) {
    // A missing file is the normal first-run case — stay silent. A present-but-
    // corrupt file (JSON parse error / read error) is worth surfacing, mirroring
    // the telemetry loader, before we start fresh.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      consola.warn("[AutoTruncate] learned-limits file unreadable/corrupted, starting fresh:", err)
    }
  }

  // Materialize the factory bake-in seed for any (model) not already loaded from
  // disk, UNCONDITIONALLY — success, ENOENT, and corrupt paths all reach here.
  // Without this, fresh installs leave DEFAULT_FACTOR_SEED unmaterialized, so
  // hasKnownLimits() is false and count_tokens skips the seed-calibrated
  // pre-check on the first request (spec §5.2 + goal 3: cold-start convergence).
  // ensureModelLimits does NOT overwrite an existing entry, so real/migrated
  // learned data always wins over the seed. Seed is a code constant — do NOT
  // schedulePersist() here (ensureModelLimits deliberately doesn't) to avoid
  // writing recomputable data to disk.
  for (const modelId of Object.keys(DEFAULT_FACTOR_SEED)) {
    ensureModelLimits(modelId)
  }
}
