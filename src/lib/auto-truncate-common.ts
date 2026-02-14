/**
 * Common types and configuration for auto-truncate modules.
 * Shared between OpenAI and Anthropic format handlers.
 */

import consola from "consola"

import { HTTPError, parseTokenLimitError } from "~/lib/error"
import {
  CLOSE_TAG,
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  OPEN_TAG,
} from "~/lib/sanitize-system-reminder"
import { bytesToKB } from "~/lib/utils"

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for auto-truncate behavior */
export interface AutoTruncateConfig {
  /** Safety margin percentage to account for token counting differences (default: 2) */
  safetyMarginPercent: number
  /** Maximum request body size in bytes (default: 510KB) */
  maxRequestBodyBytes: number
  /** Percentage of context to preserve uncompressed from the end (default: 0.7 = 70%) */
  preserveRecentPercent: number
  /** Whether to enforce token limit (default: true) */
  checkTokenLimit: boolean
  /** Whether to enforce byte/request-size limit (default: false) */
  checkByteLimit: boolean
  /** Explicit token limit override (used in reactive retry — caller has already applied margin) */
  targetTokenLimit?: number
  /** Explicit byte limit override (used in reactive retry — caller has already applied margin) */
  targetByteLimitBytes?: number
}

/** Maximum number of reactive auto-truncate retries per request */
export const MAX_AUTO_TRUNCATE_RETRIES = 5

/** Factor to apply to error-reported limit when retrying (90% of limit) */
export const AUTO_TRUNCATE_RETRY_FACTOR = 0.9

export const DEFAULT_AUTO_TRUNCATE_CONFIG: AutoTruncateConfig = {
  safetyMarginPercent: 2,
  maxRequestBodyBytes: 510 * 1024, // 510KB (585KB known to fail)
  preserveRecentPercent: 0.7,
  checkTokenLimit: true,
  checkByteLimit: false,
}

// ============================================================================
// Dynamic Byte Limit
// ============================================================================

/** Dynamic byte limit that adjusts based on 413 errors */
let dynamicByteLimit: number | null = null

/**
 * Called when a 413 error occurs. Adjusts the byte limit to 90% of the failing size.
 */
export function onRequestTooLarge(failingBytes: number): void {
  const newLimit = Math.max(Math.floor(failingBytes * 0.9), 100 * 1024)
  dynamicByteLimit = newLimit
  consola.info(`[AutoTruncate] Adjusted byte limit: ${bytesToKB(failingBytes)}KB failed → ${bytesToKB(newLimit)}KB`)
}

/** Get the current effective byte limit */
export function getEffectiveByteLimitBytes(): number {
  return dynamicByteLimit ?? DEFAULT_AUTO_TRUNCATE_CONFIG.maxRequestBodyBytes
}

/** Reset the dynamic byte limit (for testing) */
export function resetByteLimitForTesting(): void {
  dynamicByteLimit = null
}

// ============================================================================
// Dynamic Token Limit (per model)
// ============================================================================

/** Dynamic token limits per model, adjusted based on token limit errors */
const dynamicTokenLimits: Map<string, number> = new Map()

/**
 * Called when a token limit error (400) occurs.
 * Adjusts the token limit for the specific model to 95% of the reported limit.
 */
export function onTokenLimitExceeded(modelId: string, reportedLimit: number): void {
  // Use 95% of the reported limit to add safety margin
  const newLimit = Math.floor(reportedLimit * 0.95)
  const previous = dynamicTokenLimits.get(modelId)

  // Only update if the new limit is lower (more restrictive)
  if (!previous || newLimit < previous) {
    dynamicTokenLimits.set(modelId, newLimit)
    consola.info(
      `[AutoTruncate] Adjusted token limit for ${modelId}: ${reportedLimit} reported → ${newLimit} effective`,
    )
  }
}

/**
 * Get the effective token limit for a model.
 * Returns the dynamic limit if set, otherwise null to use model capabilities.
 */
export function getEffectiveTokenLimit(modelId: string): number | null {
  return dynamicTokenLimits.get(modelId) ?? null
}

/** Reset all dynamic limits (for testing) */
export function resetAllLimitsForTesting(): void {
  dynamicByteLimit = null
  dynamicTokenLimits.clear()
}

// ============================================================================
// Reactive Auto-Truncate Helpers
// ============================================================================

/**
 * Check whether a model has known limits from previous failures.
 * Used to decide whether to pre-check requests before sending.
 */
export function hasKnownLimits(modelId: string): boolean {
  return dynamicTokenLimits.has(modelId) || dynamicByteLimit !== null
}

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
  type: "token_limit" | "body_too_large"
  /** The reported limit (tokens or bytes) */
  limit?: number
  /** The current usage that exceeded the limit */
  current?: number
}

/**
 * Parse an HTTPError to detect token limit or body size errors,
 * and record the learned limit for future pre-checks.
 *
 * Returns error info if the error is a retryable limit error, null otherwise.
 */
export function tryParseAndLearnLimit(error: HTTPError, modelId: string, payloadBytes?: number): LimitErrorInfo | null {
  // 413 → body too large
  if (error.status === 413) {
    if (payloadBytes) {
      onRequestTooLarge(payloadBytes)
    }
    return { type: "body_too_large" }
  }

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

    // Record the learned limit
    onTokenLimitExceeded(modelId, tokenInfo.limit)

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
