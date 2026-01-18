/**
 * Auto-compact module: Automatically truncates conversation history
 * when it exceeds token or byte limits.
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Considers both token and byte limits
 * - Preserves system messages
 * - Filters orphaned tool_result messages
 * - Dynamic byte limit adjustment on 413 errors
 */

import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "~/lib/tokenizer"

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for auto-compact behavior */
export interface AutoCompactConfig {
  /** Safety margin percentage to account for token counting differences (default: 2) */
  safetyMarginPercent: number
  /** Maximum request body size in bytes (default: 500KB) */
  maxRequestBodyBytes: number
}

const DEFAULT_CONFIG: AutoCompactConfig = {
  safetyMarginPercent: 2,
  maxRequestBodyBytes: 500 * 1024, // 500KB (585KB known to fail)
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
  consola.info(
    `[Auto-compact] Adjusted byte limit: ${Math.round(failingBytes / 1024)}KB failed → ${Math.round(newLimit / 1024)}KB`,
  )
}

/** Get the current effective byte limit */
export function getEffectiveByteLimitBytes(): number {
  return dynamicByteLimit ?? DEFAULT_CONFIG.maxRequestBodyBytes
}

// ============================================================================
// Result Types
// ============================================================================

/** Result of auto-compact operation */
export interface AutoCompactResult {
  payload: ChatCompletionsPayload
  wasCompacted: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
}

/** Result of needs-compaction check */
export interface CompactionCheckResult {
  needed: boolean
  currentTokens: number
  tokenLimit: number
  currentBytes: number
  byteLimit: number
  reason?: "tokens" | "bytes" | "both"
}

// ============================================================================
// Limit Calculation
// ============================================================================

interface Limits {
  tokenLimit: number
  byteLimit: number
}

function calculateLimits(model: Model, config: AutoCompactConfig): Limits {
  const rawTokenLimit = model.capabilities?.limits?.max_prompt_tokens ?? 128000
  const tokenLimit = Math.floor(
    rawTokenLimit * (1 - config.safetyMarginPercent / 100),
  )
  const byteLimit = dynamicByteLimit ?? config.maxRequestBodyBytes
  return { tokenLimit, byteLimit }
}

// ============================================================================
// Message Utilities
// ============================================================================

/** Estimate tokens for a single message (fast approximation) */
function estimateMessageTokens(msg: Message): number {
  let charCount = 0

  if (typeof msg.content === "string") {
    charCount = msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        charCount += part.text.length
      } else if ("image_url" in part) {
        // Base64 images are large but compressed in token counting
        charCount += Math.min(part.image_url.url.length, 10000)
      }
    }
  }

  if (msg.tool_calls) {
    charCount += JSON.stringify(msg.tool_calls).length
  }

  // ~4 chars per token + message overhead
  return Math.ceil(charCount / 4) + 10
}

/** Get byte size of a message */
function getMessageBytes(msg: Message): number {
  return JSON.stringify(msg).length
}

/** Extract system/developer messages from the beginning */
function extractSystemMessages(messages: Array<Message>): {
  systemMessages: Array<Message>
  conversationMessages: Array<Message>
} {
  let splitIndex = 0
  while (splitIndex < messages.length) {
    const role = messages[splitIndex].role
    if (role !== "system" && role !== "developer") break
    splitIndex++
  }

  return {
    systemMessages: messages.slice(0, splitIndex),
    conversationMessages: messages.slice(splitIndex),
  }
}

/** Get tool_use IDs from an assistant message */
function getToolCallIds(msg: Message): Array<string> {
  if (msg.role === "assistant" && msg.tool_calls) {
    return msg.tool_calls.map((tc: ToolCall) => tc.id)
  }
  return []
}

/** Filter orphaned tool_result messages */
function filterOrphanedToolResults(messages: Array<Message>): Array<Message> {
  // Collect all available tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getToolCallIds(msg)) {
      toolUseIds.add(id)
    }
  }

  // Filter out orphaned tool messages
  let removedCount = 0
  const filtered = messages.filter((msg) => {
    if (
      msg.role === "tool"
      && msg.tool_call_id
      && !toolUseIds.has(msg.tool_call_id)
    ) {
      removedCount++
      return false
    }
    return true
  })

  if (removedCount > 0) {
    consola.debug(`Auto-compact: Filtered ${removedCount} orphaned tool_result`)
  }

  return filtered
}

/** Ensure messages start with a user message */
function ensureStartsWithUser(messages: Array<Message>): Array<Message> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(
      `Auto-compact: Skipped ${startIndex} leading non-user messages`,
    )
  }

  return messages.slice(startIndex)
}

// ============================================================================
// Binary Search Algorithm
// ============================================================================

interface PreserveSearchParams {
  messages: Array<Message>
  systemBytes: number
  systemTokens: number
  payloadOverhead: number
  tokenLimit: number
  byteLimit: number
}

/**
 * Find the optimal index from which to preserve messages.
 * Uses binary search with pre-calculated cumulative sums.
 * Returns the smallest index where the preserved portion fits within limits.
 */
function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const {
    messages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
  } = params

  if (messages.length === 0) return 0

  // Account for truncation marker (~200 bytes, ~50 tokens)
  const markerBytes = 200
  const markerTokens = 50

  // Calculate available budget after system messages, marker, and overhead
  const availableTokens = tokenLimit - systemTokens - markerTokens
  // For bytes: payload = overhead + "[" + messages.join(",") + "]"
  // Each message adds: JSON.stringify(msg) + 1 (comma, except last)
  const availableBytes = byteLimit - payloadOverhead - systemBytes - markerBytes

  if (availableTokens <= 0 || availableBytes <= 0) {
    return messages.length // Cannot fit any messages
  }

  // Pre-calculate cumulative sums from the end
  // cumulative[i] = sum of all messages from index i to end
  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)
  const cumBytes: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    const msg = messages[i]
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(msg)
    // Add 1 for JSON comma separator (conservative estimate)
    cumBytes[i] = cumBytes[i + 1] + getMessageBytes(msg) + 1
  }

  // Binary search for the smallest index where both limits are satisfied
  let left = 0
  let right = n

  while (left < right) {
    const mid = (left + right) >>> 1
    if (cumTokens[mid] <= availableTokens && cumBytes[mid] <= availableBytes) {
      right = mid // Can keep more messages
    } else {
      left = mid + 1 // Need to remove more
    }
  }

  return left
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Check if payload needs compaction based on model limits or byte size.
 */
export async function checkNeedsCompaction(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoCompactConfig> = {},
): Promise<CompactionCheckResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  const tokenCount = await getTokenCount(payload, model)
  const currentTokens = tokenCount.input
  const currentBytes = JSON.stringify(payload).length

  const exceedsTokens = currentTokens > tokenLimit
  const exceedsBytes = currentBytes > byteLimit

  let reason: "tokens" | "bytes" | "both" | undefined
  if (exceedsTokens && exceedsBytes) {
    reason = "both"
  } else if (exceedsTokens) {
    reason = "tokens"
  } else if (exceedsBytes) {
    reason = "bytes"
  }

  return {
    needed: exceedsTokens || exceedsBytes,
    currentTokens,
    tokenLimit,
    currentBytes,
    byteLimit,
    reason,
  }
}

/** Create a truncation marker message */
function createTruncationMarker(removedCount: number): Message {
  return {
    role: "user",
    content: `[CONTEXT TRUNCATED: ${removedCount} earlier messages removed to fit context limits]`,
  }
}

/**
 * Perform auto-compaction on a payload that exceeds limits.
 * Uses binary search to find the optimal truncation point.
 */
export async function autoCompact(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoCompactConfig> = {},
): Promise<AutoCompactResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  // Measure original size
  const payloadJson = JSON.stringify(payload)
  const originalBytes = payloadJson.length
  const tokenCount = await getTokenCount(payload, model)
  const originalTokens = tokenCount.input

  // Check if compaction is needed
  if (originalTokens <= tokenLimit && originalBytes <= byteLimit) {
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Log reason
  const exceedsTokens = originalTokens > tokenLimit
  const exceedsBytes = originalBytes > byteLimit
  let reason: string
  if (exceedsTokens && exceedsBytes) {
    reason = "tokens and size"
  } else if (exceedsBytes) {
    reason = "size"
  } else {
    reason = "tokens"
  }

  consola.info(
    `Auto-compact: Exceeds ${reason} limit (${originalTokens} tokens, ${Math.round(originalBytes / 1024)}KB)`,
  )

  // Extract system messages
  const { systemMessages, conversationMessages } = extractSystemMessages(
    payload.messages,
  )

  // Calculate overhead: everything except the messages array content
  const messagesJson = JSON.stringify(payload.messages)
  const payloadOverhead = originalBytes - messagesJson.length

  // Calculate system message sizes
  const systemBytes = systemMessages.reduce(
    (sum, m) => sum + getMessageBytes(m) + 1,
    0,
  )
  const systemTokens = systemMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  )

  consola.debug(
    `Auto-compact: overhead=${Math.round(payloadOverhead / 1024)}KB, `
      + `system=${systemMessages.length} msgs (${Math.round(systemBytes / 1024)}KB)`,
  )

  // Find optimal preserve index
  const preserveIndex = findOptimalPreserveIndex({
    messages: conversationMessages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
  })

  // Check if we can compact
  if (preserveIndex === 0) {
    consola.warn("Auto-compact: Cannot truncate, system messages too large")
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  if (preserveIndex >= conversationMessages.length) {
    consola.warn("Auto-compact: Would need to remove all messages")
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Build preserved messages
  let preserved = conversationMessages.slice(preserveIndex)

  // Clean up the message list
  preserved = filterOrphanedToolResults(preserved)
  preserved = ensureStartsWithUser(preserved)
  preserved = filterOrphanedToolResults(preserved)

  if (preserved.length === 0) {
    consola.warn("Auto-compact: All messages filtered out after cleanup")
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Build new payload
  const removedCount = conversationMessages.length - preserved.length
  const marker = createTruncationMarker(removedCount)

  const newPayload: ChatCompletionsPayload = {
    ...payload,
    messages: [...systemMessages, marker, ...preserved],
  }

  // Verify the result
  const newBytes = JSON.stringify(newPayload).length
  const newTokenCount = await getTokenCount(newPayload, model)

  consola.info(
    `Auto-compact: ${originalTokens} → ${newTokenCount.input} tokens, `
      + `${Math.round(originalBytes / 1024)}KB → ${Math.round(newBytes / 1024)}KB `
      + `(removed ${removedCount} messages)`,
  )

  // Warn if still over limit (shouldn't happen with correct algorithm)
  if (newBytes > byteLimit) {
    consola.warn(
      `Auto-compact: Result still over byte limit (${Math.round(newBytes / 1024)}KB > ${Math.round(byteLimit / 1024)}KB)`,
    )
  }

  return {
    payload: newPayload,
    wasCompacted: true,
    originalTokens,
    compactedTokens: newTokenCount.input,
    removedMessageCount: removedCount,
  }
}

/**
 * Create a marker to prepend to responses indicating auto-compaction occurred.
 */
export function createCompactionMarker(result: AutoCompactResult): string {
  if (!result.wasCompacted) return ""

  const reduction = result.originalTokens - result.compactedTokens
  const percentage = Math.round((reduction / result.originalTokens) * 100)

  return (
    `\n\n---\n[Auto-compacted: ${result.removedMessageCount} messages removed, `
    + `${result.originalTokens} → ${result.compactedTokens} tokens (${percentage}% reduction)]`
  )
}
