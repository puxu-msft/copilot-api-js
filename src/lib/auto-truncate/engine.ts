/**
 * Common types and configuration for auto-truncate modules.
 * Shared between OpenAI and Anthropic format handlers.
 */

import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/config/paths"
import { HTTPError } from "~/lib/error"
import { parseTokenLimitError } from "~/lib/error/parsing"
import {
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

/** Per-model learned limits with tokenizer calibration */
export interface ModelLimits {
  /** Token upper bound (from error response's reported limit) */
  tokenLimit: number
  /** Calibration factor: actualTokens / gptEstimatedTokens.
   *  > 1.0 means GPT tokenizer underestimates (Claude tokenizer produces more tokens).
   *  < 1.0 means GPT tokenizer overestimates. */
  calibrationFactor: number
  /** Number of calibration samples (higher = more reliable factor) */
  sampleCount: number
  /** Last updated timestamp (ms since epoch) */
  updatedAt: number
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
 * Records the learned limit and optionally updates calibration.
 */
export function onTokenLimitExceeded(
  modelId: string,
  reportedLimit: number,
  reportedCurrent?: number,
  estimatedTokens?: number,
): void {
  // Update learned limits (with calibration data for future pre-checks)
  const existing = learnedLimits.get(modelId)

  // Only update if this is the first time or the new limit is lower (more restrictive)
  if (!existing || reportedLimit < existing.tokenLimit) {
    learnedLimits.set(modelId, {
      tokenLimit: reportedLimit,
      calibrationFactor: existing?.calibrationFactor ?? 1.0,
      sampleCount: existing?.sampleCount ?? 0,
      updatedAt: Date.now(),
    })
    consola.info(`[AutoTruncate] Learned token limit for ${modelId}: ${reportedLimit}`)
  }

  // Calibrate tokenizer if we have both actual and estimated token counts
  if (reportedCurrent !== undefined && estimatedTokens !== undefined && estimatedTokens > 0) {
    updateCalibration(modelId, reportedCurrent, estimatedTokens)
    const lim = learnedLimits.get(modelId)
    if (lim) {
      consola.info(
        `[AutoTruncate] Calibration for ${modelId}: actual=${reportedCurrent} vs estimated=${estimatedTokens}`
          + ` → factor=${lim.calibrationFactor.toFixed(3)} (${lim.sampleCount} samples)`,
      )
    }
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
// Calibration (EWMA)
// ============================================================================

const CALIBRATION_ALPHA = 0.3
const CALIBRATION_MIN = 0.5
const CALIBRATION_MAX = 3.0

/**
 * Update the per-model calibration factor using EWMA.
 *
 * Called after a token limit error when we know both the GPT tokenizer estimate
 * and the actual token count (from the error response). The ratio between them
 * tells us how much the GPT tokenizer over/under-estimates for this model.
 */
export function updateCalibration(modelId: string, actualTokens: number, estimatedTokens: number): void {
  if (estimatedTokens <= 0) return
  const limits = learnedLimits.get(modelId)
  if (!limits) return

  const rawFactor = actualTokens / estimatedTokens
  const clamped = Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, rawFactor))

  if (limits.sampleCount === 0) {
    limits.calibrationFactor = clamped
  } else {
    limits.calibrationFactor = CALIBRATION_ALPHA * clamped + (1 - CALIBRATION_ALPHA) * limits.calibrationFactor
  }
  limits.sampleCount++
  limits.updatedAt = Date.now()
}

/** Apply calibration factor to a GPT tokenizer estimate */
export function calibrate(modelId: string, gptEstimate: number): number {
  const limits = learnedLimits.get(modelId)
  if (!limits || limits.sampleCount === 0) return gptEstimate
  return Math.ceil(gptEstimate * limits.calibrationFactor)
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
  version: 1
  limits: Record<string, ModelLimits>
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 5000

/** Schedule an async write of learned limits (debounced) */
export function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistLimits()
  }, PERSIST_DEBOUNCE_MS)
}

/** Write learned limits to disk */
export async function persistLimits(): Promise<void> {
  if (learnedLimits.size === 0) return
  const data: LearnedLimitsFile = { version: 1, limits: Object.fromEntries(learnedLimits) }
  try {
    await fs.writeFile(PATHS.LEARNED_LIMITS, JSON.stringify(data, null, 2), "utf8")
  } catch {
    // Write failure is non-critical — limits will be re-learned on next error
  }
}

/** Load previously persisted limits from disk (called at startup) */
export async function loadPersistedLimits(): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.LEARNED_LIMITS, "utf8")
    const data = JSON.parse(raw) as LearnedLimitsFile
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: persisted file may have unexpected version
    if (data.version !== 1) return
    for (const [modelId, lim] of Object.entries(data.limits)) {
      if (lim.tokenLimit > 0 && lim.calibrationFactor >= CALIBRATION_MIN && lim.calibrationFactor <= CALIBRATION_MAX) {
        learnedLimits.set(modelId, lim)
      }
    }
    if (learnedLimits.size > 0) {
      consola.info(`[AutoTruncate] Loaded learned limits for ${learnedLimits.size} model(s)`)
    }
  } catch {
    // File doesn't exist or is corrupted — start fresh
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
export function tryParseAndLearnLimit(
  error: HTTPError,
  modelId: string,
  learn = true,
  estimatedTokens?: number,
): LimitErrorInfo | null {
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
    const isTokenError =
      errorJson.error.code === "model_max_prompt_tokens_exceeded" || errorJson.error.type === "invalid_request_error"

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
export function compressToolResultContent(content: string): string {
  if (content.length <= LARGE_TOOL_RESULT_THRESHOLD) {
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

  return (
    `${OPEN_TAG}\n`
    + `[Compressed] ${toolName} tool result (${innerContent.length.toLocaleString()} chars). `
    + `Preview: ${preview}\n`
    + CLOSE_TAG
  )
}
