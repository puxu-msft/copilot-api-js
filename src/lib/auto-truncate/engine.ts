/**
 * Common types and configuration for auto-truncate modules.
 * Shared between OpenAI and Anthropic format handlers.
 */

import consola from "consola"
import fs from "node:fs/promises"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "~/lib/atomic-fs"
import { PATHS } from "~/lib/config/paths"
import { HTTPError } from "~/lib/error"
import { parseTokenLimitError } from "~/lib/error"
import {
  //
  CLOSE_TAG,
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  OPEN_TAG,
} from "~/lib/system-prompt"

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for auto-truncate behavior */
export interface AutoTruncateConfig {
  /** Safety margin percentage to account for token counting differences (default: 2) */
  safetyMarginPercent: number
  /** Percentage of context to preserve uncompressed from the end (default: 0.7 = 70%) */
  preserveRecentPercent: number
  /** Whether to enforce token limit (default: true) */
  checkTokenLimit: boolean
  /** Explicit token limit override (used in reactive retry — caller has already applied margin) */
  targetTokenLimit?: number
}

/** Maximum number of reactive auto-truncate retries per request */
export const MAX_AUTO_TRUNCATE_RETRIES = 5

/** Factor to apply to error-reported limit when retrying (90% of limit) */
export const AUTO_TRUNCATE_RETRY_FACTOR = 0.9

export const DEFAULT_AUTO_TRUNCATE_CONFIG: AutoTruncateConfig = {
  safetyMarginPercent: 2,
  preserveRecentPercent: 0.7,
  checkTokenLimit: true,
}

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
  /** Only set once a 400 taught us the real cap; seed-only models leave it undefined
   *  so calculateTokenLimit falls back to model capabilities. */
  tokenLimit?: number
  factorModel: FactorModel
  /** LIVE learning events only (success + 400); seed/backfill do NOT bump it.
   *  Drives computeSafetyMargin so synthetic priors never collapse the margin. */
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

/**
 * Check whether a model has known limits from previous failures.
 * Used to decide whether to pre-check requests before sending.
 */
export function hasKnownLimits(modelId: string): boolean {
  return learnedLimits.has(modelId)
}

// ============================================================================
// Token Limit Learning
// ============================================================================

/**
 * Called when a token limit error (400) occurs.
 * Records the learned limit and feeds calibration into the size bucket.
 */
export function onTokenLimitExceeded(modelId: string, reportedLimit: number, reportedCurrent?: number, estimatedTokens?: number): void {
  // Ensure a (seeded) entry exists, then update the learned cap.
  const limits = ensureModelLimits(modelId)

  // N1: seed-only models start with tokenLimit === undefined, so the first 400
  // must write it; afterward only tighten (lower = more restrictive).
  if (limits.tokenLimit === undefined || reportedLimit < limits.tokenLimit) {
    limits.tokenLimit = reportedLimit
    limits.updatedAt = Date.now()
    consola.info(`[AutoTruncate] Learned token limit for ${modelId}: ${reportedLimit}`)
  }

  // Feed the 400's (estimate, real) pair into the size-aware calibration model.
  if (reportedCurrent !== undefined && estimatedTokens !== undefined && estimatedTokens > 0) {
    learnCalibration(modelId, estimatedTokens, reportedCurrent, { isLive: true })
    consola.info(
      `[AutoTruncate] Calibration for ${modelId}: actual=${reportedCurrent} vs estimated=${estimatedTokens}`
        + ` → factor=${factorAt(modelId, estimatedTokens).toFixed(3)}`,
    )
  }

  schedulePersist()
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

// ============================================================================
// Dynamic Safety Margin
// ============================================================================

const BASE_MARGIN = 0.03
const BONUS_MARGIN_PER_SAMPLE = 0.07

/**
 * Compute dynamic safety margin based on calibration confidence.
 * Fewer samples → wider margin (conservative). More samples → narrower margin.
 *
 * - 0 samples: 10% (0.03 + 0.07)
 * - 1 sample:  10%
 * - 10 samples: ~3.7%
 * - ∞ samples:  3%
 */
export function computeSafetyMargin(sampleCount: number): number {
  if (sampleCount <= 0) return BASE_MARGIN + BONUS_MARGIN_PER_SAMPLE
  return BASE_MARGIN + BONUS_MARGIN_PER_SAMPLE / sampleCount
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
        // boundsVersion 不匹配（或缺 factorModel）→ 丢桶重 seed（保留 tokenLimit/liveSampleCount）
        const persisted = lim.factorModel
        const fm = persisted && persisted.boundsVersion === FACTOR_BOUNDS_VERSION ? persisted : seedFactorModel(modelId)
        learnedLimits.set(modelId, {
          ...(lim.tokenLimit !== undefined && { tokenLimit: lim.tokenLimit }),
          factorModel: fm,
          liveSampleCount: lim.liveSampleCount ?? 0,
          updatedAt: lim.updatedAt ?? Date.now(),
        })
      }
    } else if (data.version === 1) {
      for (const [modelId, lim] of Object.entries(data.limits as Record<string, { tokenLimit: number; calibrationFactor: number; sampleCount?: number }>)) {
        const fm = Object.hasOwn(DEFAULT_FACTOR_SEED, modelId) ? seedFactorModel(modelId) : seedTopBucketOnly(lim.calibrationFactor)
        learnedLimits.set(modelId, {
          ...(lim.tokenLimit > 0 && { tokenLimit: lim.tokenLimit }),
          factorModel: fm,
          liveSampleCount: lim.sampleCount ?? 0,
          updatedAt: Date.now(),
        })
      }
    } else {
      return
    }
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
}

// ============================================================================
// Reactive Auto-Truncate Helpers
// ============================================================================

/** Copilot error structure for JSON parsing */
interface CopilotErrorBody {
  error?: {
    message?: string
    code?: string
    type?: string
  }
}

/** Result from tryParseAndLearnLimit */
export interface LimitErrorInfo {
  type: "token_limit"
  /** The reported limit (tokens) */
  limit?: number
  /** The current usage that exceeded the limit */
  current?: number
}

/**
 * Parse an HTTPError to detect token limit errors,
 * and record the learned limit for future pre-checks.
 *
 * When `estimatedTokens` is provided (the GPT tokenizer estimate at the time
 * of the error), also updates the per-model calibration factor.
 *
 * Returns error info if the error is a retryable token limit error, null otherwise.
 */
export function tryParseAndLearnLimit(error: HTTPError, modelId: string, learn = true, estimatedTokens?: number): LimitErrorInfo | null {
  // 400 → try to parse token limit
  if (error.status === 400) {
    let errorJson: CopilotErrorBody | undefined
    try {
      errorJson = JSON.parse(error.responseText) as CopilotErrorBody
    } catch {
      return null
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- errorJson.error may be undefined at runtime
    if (!errorJson?.error?.message) return null

    // Check OpenAI format (code: "model_max_prompt_tokens_exceeded")
    // or Anthropic format (type: "invalid_request_error")
    const isTokenError = errorJson.error.code === "model_max_prompt_tokens_exceeded" || errorJson.error.type === "invalid_request_error"

    if (!isTokenError) return null

    const tokenInfo = parseTokenLimitError(errorJson.error.message)
    if (!tokenInfo) return null

    // Record the learned limit (only when auto-truncate is enabled)
    if (learn) {
      onTokenLimitExceeded(modelId, tokenInfo.limit, tokenInfo.current, estimatedTokens)
    }

    return {
      type: "token_limit",
      limit: tokenInfo.limit,
      current: tokenInfo.current,
    }
  }

  return null
}

// ============================================================================
// Tool Result Compression
// ============================================================================

/** Threshold for large tool_result content (bytes) */
export const LARGE_TOOL_RESULT_THRESHOLD = 10000 // 10KB

/** Maximum length for compressed tool_result summary */
const COMPRESSED_SUMMARY_LENGTH = 500

/**
 * Compress a large tool_result content to a summary.
 * Keeps the first and last portions with a note about truncation.
 *
 * Preserves `<system-reminder>` tag wrappers (injected by Claude Code)
 * with a truncated summary of their content, instead of letting them
 * get sliced into broken XML fragments by character-level truncation.
 */
export function compressToolResultContent(content: string, threshold: number = LARGE_TOOL_RESULT_THRESHOLD): string {
  if (content.length <= threshold) {
    return content
  }

  // Extract trailing <system-reminder> tags before compression.
  // These are preserved as truncated summaries instead of being sliced
  // into broken XML fragments by character-level truncation.
  const { mainContentEnd, tags } = extractTrailingSystemReminderTags(content)
  const reminders = tags.map((tag) => {
    const summary = tag.content.trim().split("\n")[0].slice(0, 80)
    return `${OPEN_TAG}\n[Truncated] ${summary}\n${CLOSE_TAG}`
  })

  const mainContent = content.slice(0, mainContentEnd)

  // Compress the main content (without trailing system-reminder tags)
  const halfLen = Math.floor(COMPRESSED_SUMMARY_LENGTH / 2)
  const start = mainContent.slice(0, halfLen)
  const end = mainContent.slice(-halfLen)
  const removedChars = mainContent.length - COMPRESSED_SUMMARY_LENGTH

  let result = `${start}\n\n[... ${removedChars.toLocaleString()} characters omitted for brevity ...]\n\n${end}`

  // Re-append preserved system-reminder tags
  if (reminders.length > 0) {
    result += "\n" + reminders.join("\n")
  }

  return result
}

// ============================================================================
// Compacted Text Block Compression
// ============================================================================

/** Prefix that identifies a compacted tool result in a system-reminder tag */
const COMPACTED_RESULT_PREFIX = "Result of calling the "

/**
 * Compress a compacted tool result text block.
 *
 * Claude Code compacts tool_result blocks into text blocks wrapped in
 * `<system-reminder>` tags during conversation summarization. Format:
 *
 *     <system-reminder>
 *     Result of calling the Read tool: "     1→...file content..."
 *     </system-reminder>
 *
 * These blocks can be very large (entire file contents) but are low-value
 * since the file can be re-read. This replaces the full content with a
 * compressed summary preserving the tool name and a short preview.
 *
 * Returns the compressed text, or `null` if the text doesn't match
 * the expected compacted format.
 */
export function compressCompactedReadResult(text: string): string | null {
  const { mainContentStart, tags } = extractLeadingSystemReminderTags(text)

  // Must be exactly one system-reminder tag covering the entire text
  if (tags.length !== 1) return null
  // Allow trailing whitespace/newlines after the tag
  if (mainContentStart < text.length && text.slice(mainContentStart).trim() !== "") return null

  const content = tags[0].content
  if (!content.startsWith(COMPACTED_RESULT_PREFIX)) return null

  // Extract tool name: "Result of calling the Read tool: "..."
  const colonPos = content.indexOf(": ", COMPACTED_RESULT_PREFIX.length)
  if (colonPos === -1) return null

  const toolName = content.slice(COMPACTED_RESULT_PREFIX.length, colonPos).replace(/ tool$/, "")

  // Extract the quoted content after ": "
  const afterColon = content.slice(colonPos + 2)
  if (!afterColon.startsWith('"')) return null

  // Get the inner content (between quotes) — may use \" escapes
  const innerContent = afterColon.slice(1, afterColon.endsWith('"') ? -1 : undefined)

  // Build a short preview from the first meaningful line
  const firstLines = innerContent.split(String.raw`\n`).slice(0, 3)
  const preview = firstLines.join(" | ").slice(0, 150)

  return `${OPEN_TAG}\n` + `[Compressed] ${toolName} tool result (${innerContent.length.toLocaleString()} chars). ` + `Preview: ${preview}\n` + CLOSE_TAG
}
