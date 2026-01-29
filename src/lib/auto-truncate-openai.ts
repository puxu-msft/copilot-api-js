/**
 * Auto-truncate module: Automatically truncates conversation history
 * when it exceeds token or byte limits (OpenAI format).
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Considers both token and byte limits
 * - Preserves system messages
 * - Filters orphaned tool_result and tool_use messages
 * - Dynamic byte limit adjustment on 413 errors
 * - Optional smart compression of old tool_result content
 */

import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import type { AutoTruncateConfig } from "./auto-truncate-common"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  getEffectiveByteLimitBytes,
  getEffectiveTokenLimit,
} from "./auto-truncate-common"

// Re-export for backwards compatibility
export {
  getEffectiveByteLimitBytes,
  onRequestTooLarge,
} from "./auto-truncate-common"
export type { AutoTruncateConfig } from "./auto-truncate-common"

// ============================================================================
// Result Types
// ============================================================================

/** Result of auto-truncate operation */
export interface OpenAIAutoTruncateResult {
  payload: ChatCompletionsPayload
  wasCompacted: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
}

/** Result of needs-compaction check */
export interface OpenAICompactionCheckResult {
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

function calculateLimits(model: Model, config: AutoTruncateConfig): Limits {
  // Check for dynamic token limit (adjusted based on previous errors)
  const dynamicLimit = getEffectiveTokenLimit(model.id)

  // Use dynamic limit if available, otherwise use model capabilities
  const rawTokenLimit =
    dynamicLimit
    ?? model.capabilities?.limits?.max_context_window_tokens
    ?? model.capabilities?.limits?.max_prompt_tokens
    ?? 128000

  const tokenLimit = Math.floor(
    rawTokenLimit * (1 - config.safetyMarginPercent / 100),
  )
  const byteLimit = getEffectiveByteLimitBytes()
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
    consola.debug(
      `[AutoTruncate:OpenAI] Filtered ${removedCount} orphaned tool_result`,
    )
  }

  return filtered
}

/** Get tool_result IDs from all tool messages */
function getToolResultIds(messages: Array<Message>): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      ids.add(msg.tool_call_id)
    }
  }
  return ids
}

/** Filter orphaned tool_use messages (those without matching tool_result) */
function filterOrphanedToolUse(messages: Array<Message>): Array<Message> {
  const toolResultIds = getToolResultIds(messages)

  // Filter out orphaned tool_calls from assistant messages
  const result: Array<Message> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      const filteredToolCalls = msg.tool_calls.filter((tc: ToolCall) => {
        if (!toolResultIds.has(tc.id)) {
          removedCount++
          return false
        }
        return true
      })

      // If all tool_calls were removed but there's still content, keep the message
      if (filteredToolCalls.length === 0) {
        if (msg.content) {
          result.push({ ...msg, tool_calls: undefined })
        }
        // Skip message entirely if no content and no tool_calls
        continue
      }

      result.push({ ...msg, tool_calls: filteredToolCalls })
      continue
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(
      `[AutoTruncate:OpenAI] Filtered ${removedCount} orphaned tool_use`,
    )
  }

  return result
}

/** Ensure messages start with a user message */
function ensureStartsWithUser(messages: Array<Message>): Array<Message> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(
      `[AutoTruncate:OpenAI] Skipped ${startIndex} leading non-user messages`,
    )
  }

  return messages.slice(startIndex)
}

// ============================================================================
// Smart Tool Result Compression
// ============================================================================

/** Threshold for large tool message content (bytes) */
const LARGE_TOOL_RESULT_THRESHOLD = 10000 // 10KB

/** Maximum length for compressed tool_result summary */
const COMPRESSED_SUMMARY_LENGTH = 500

/**
 * Compress a large tool message content to a summary.
 * Keeps the first and last portions with a note about truncation.
 */
function compressToolResultContent(content: string): string {
  if (content.length <= LARGE_TOOL_RESULT_THRESHOLD) {
    return content
  }

  const halfLen = Math.floor(COMPRESSED_SUMMARY_LENGTH / 2)
  const start = content.slice(0, halfLen)
  const end = content.slice(-halfLen)
  const removedChars = content.length - COMPRESSED_SUMMARY_LENGTH

  return `${start}\n\n[... ${removedChars.toLocaleString()} characters omitted for brevity ...]\n\n${end}`
}

/**
 * Smart compression strategy for OpenAI format:
 * 1. Calculate tokens/bytes from the end until reaching preservePercent of limit
 * 2. Messages before that threshold get their tool content compressed
 * 3. Returns compressed messages and stats
 *
 * @param preservePercent - Percentage of context to preserve uncompressed (0.0-1.0)
 */
function smartCompressToolResults(
  messages: Array<Message>,
  tokenLimit: number,
  byteLimit: number,
  preservePercent: number,
): {
  messages: Array<Message>
  compressedCount: number
  compressThresholdIndex: number
} {
  // Calculate cumulative size from the end
  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)
  const cumBytes: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    const msg = messages[i]
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(msg)
    cumBytes[i] = cumBytes[i + 1] + getMessageBytes(msg) + 1
  }

  // Find the threshold index where we've used the preserve percentage of the limit
  const preserveTokenLimit = Math.floor(tokenLimit * preservePercent)
  const preserveByteLimit = Math.floor(byteLimit * preservePercent)

  let thresholdIndex = n
  for (let i = n - 1; i >= 0; i--) {
    if (cumTokens[i] > preserveTokenLimit || cumBytes[i] > preserveByteLimit) {
      thresholdIndex = i + 1
      break
    }
    thresholdIndex = i
  }

  // If threshold is at the end, nothing to compress
  if (thresholdIndex >= n) {
    return { messages, compressedCount: 0, compressThresholdIndex: n }
  }

  // Compress tool messages before threshold
  const result: Array<Message> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (
      i < thresholdIndex
      && msg.role === "tool"
      && typeof msg.content === "string"
      && msg.content.length > LARGE_TOOL_RESULT_THRESHOLD
    ) {
      compressedCount++
      result.push({
        ...msg,
        content: compressToolResultContent(msg.content),
      })
      continue
    }
    result.push(msg)
  }

  return {
    messages: result,
    compressedCount,
    compressThresholdIndex: thresholdIndex,
  }
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
export async function checkNeedsCompactionOpenAI(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<OpenAICompactionCheckResult> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
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

/**
 * Generate a summary of removed messages for context.
 * Extracts key information like tool calls and topics.
 */
function generateRemovedMessagesSummary(
  removedMessages: Array<Message>,
): string {
  const toolCalls: Array<string> = []
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const msg of removedMessages) {
    if (msg.role === "user") {
      userMessageCount++
    } else if (msg.role === "assistant") {
      assistantMessageCount++
    }

    // Extract tool call names
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name) {
          toolCalls.push(tc.function.name)
        }
      }
    }
  }

  // Build summary parts
  const parts: Array<string> = []

  // Message breakdown
  if (userMessageCount > 0 || assistantMessageCount > 0) {
    const breakdown = []
    if (userMessageCount > 0) breakdown.push(`${userMessageCount} user`)
    if (assistantMessageCount > 0)
      breakdown.push(`${assistantMessageCount} assistant`)
    parts.push(`Messages: ${breakdown.join(", ")}`)
  }

  // Tool calls
  if (toolCalls.length > 0) {
    // Deduplicate and limit
    const uniqueTools = [...new Set(toolCalls)]
    const displayTools =
      uniqueTools.length > 5 ?
        [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`]
      : uniqueTools
    parts.push(`Tools used: ${displayTools.join(", ")}`)
  }

  return parts.join(". ")
}

/**
 * Add a compression notice to the system message.
 * Informs the model that some tool content has been compressed.
 */
function addCompressionNotice(
  payload: ChatCompletionsPayload,
  compressedCount: number,
): ChatCompletionsPayload {
  const notice =
    `\n\n[CONTEXT NOTE]\n`
    + `${compressedCount} large tool results have been compressed to reduce context size.\n`
    + `The compressed results show the beginning and end of the content with an omission marker.\n`
    + `If you need the full content, you can re-read the file or re-run the tool.\n`
    + `[END NOTE]`

  // Find last system message and append notice
  const messages = [...payload.messages]
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "system" || msg.role === "developer") {
      if (typeof msg.content === "string") {
        messages[i] = { ...msg, content: msg.content + notice }
      }
      break
    }
  }

  return { ...payload, messages }
}

/**
 * Create truncation context to append to system messages.
 */
function createTruncationSystemContext(
  removedCount: number,
  compressedCount: number,
  summary: string,
): string {
  let context = `\n\n[CONVERSATION CONTEXT]\n`

  if (removedCount > 0) {
    context += `${removedCount} earlier messages have been removed due to context window limits.\n`
  }

  if (compressedCount > 0) {
    context += `${compressedCount} large tool results have been compressed.\n`
  }

  if (summary) {
    context += `Summary of removed content: ${summary}\n`
  }

  context +=
    `If you need earlier context, ask the user or check available tools for conversation history access.\n`
    + `[END CONTEXT]`

  return context
}

/** Create a truncation marker message (fallback when no system message) */
function createTruncationMarker(
  removedCount: number,
  compressedCount: number,
  summary: string,
): Message {
  const parts: Array<string> = []

  if (removedCount > 0) {
    parts.push(`${removedCount} earlier messages removed`)
  }
  if (compressedCount > 0) {
    parts.push(`${compressedCount} tool results compressed`)
  }

  let content = `[CONTEXT MODIFIED: ${parts.join(", ")} to fit context limits]`
  if (summary) {
    content += `\n[Summary: ${summary}]`
  }
  return {
    role: "user",
    content,
  }
}

/**
 * Perform auto-truncation on a payload that exceeds limits.
 * Uses binary search to find the optimal truncation point.
 */
export async function autoTruncateOpenAI(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<OpenAIAutoTruncateResult> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
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

  // Log reason with correct comparison
  const exceedsTokens = originalTokens > tokenLimit
  const exceedsBytes = originalBytes > byteLimit

  // Step 1: Smart compress old tool messages (if enabled)
  // Compress tool messages in the older portion of the context
  let workingMessages = payload.messages
  let compressedCount = 0

  if (state.compressToolResults) {
    const compressionResult = smartCompressToolResults(
      payload.messages,
      tokenLimit,
      byteLimit,
      cfg.preserveRecentPercent,
    )
    workingMessages = compressionResult.messages
    compressedCount = compressionResult.compressedCount

    // Check if compression alone was enough
    const compressedPayload = { ...payload, messages: workingMessages }
    const compressedBytes = JSON.stringify(compressedPayload).length
    const compressedTokenCount = await getTokenCount(compressedPayload, model)

    if (
      compressedTokenCount.input <= tokenLimit
      && compressedBytes <= byteLimit
    ) {
      // Log single line summary
      let reason = "tokens"
      if (exceedsTokens && exceedsBytes) reason = "tokens+size"
      else if (exceedsBytes) reason = "size"
      consola.info(
        `[AutoTruncate:OpenAI] ${reason}: ${originalTokens}→${compressedTokenCount.input} tokens, `
          + `${Math.round(originalBytes / 1024)}→${Math.round(compressedBytes / 1024)}KB `
          + `(compressed ${compressedCount} tool_results)`,
      )

      // Add compression notice to system message
      const noticePayload = addCompressionNotice(
        compressedPayload,
        compressedCount,
      )
      const noticeTokenCount = await getTokenCount(noticePayload, model)

      return {
        payload: noticePayload,
        wasCompacted: true,
        originalTokens,
        compactedTokens: noticeTokenCount.input,
        removedMessageCount: 0,
      }
    }
  }

  // Step 2: Compression wasn't enough (or disabled), proceed with message removal
  // Use working messages (compressed if enabled, original otherwise)

  // Extract system messages from working messages
  const { systemMessages, conversationMessages } =
    extractSystemMessages(workingMessages)

  // Calculate overhead: everything except the messages array content
  const messagesJson = JSON.stringify(workingMessages)
  const workingPayloadSize = JSON.stringify({
    ...payload,
    messages: workingMessages,
  }).length
  const payloadOverhead = workingPayloadSize - messagesJson.length

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
    `[AutoTruncate:OpenAI] overhead=${Math.round(payloadOverhead / 1024)}KB, `
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
    consola.warn(
      "[AutoTruncate:OpenAI] Cannot truncate, system messages too large",
    )
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  if (preserveIndex >= conversationMessages.length) {
    consola.warn("[AutoTruncate:OpenAI] Would need to remove all messages")
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

  // Clean up the message list - filter both orphaned tool_result and tool_use
  preserved = filterOrphanedToolResults(preserved)
  preserved = filterOrphanedToolUse(preserved)
  preserved = ensureStartsWithUser(preserved)
  // Run again after ensuring starts with user, in case we skipped messages
  preserved = filterOrphanedToolResults(preserved)
  preserved = filterOrphanedToolUse(preserved)

  if (preserved.length === 0) {
    consola.warn(
      "[AutoTruncate:OpenAI] All messages filtered out after cleanup",
    )
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Calculate removed messages and generate summary
  const removedMessages = conversationMessages.slice(0, preserveIndex)
  const removedCount = conversationMessages.length - preserved.length
  const summary = generateRemovedMessagesSummary(removedMessages)

  // Build new payload with truncation context
  let newSystemMessages = systemMessages
  let newMessages = preserved

  // Prefer adding context to last system message (cleaner for the model)
  if (systemMessages.length > 0) {
    const truncationContext = createTruncationSystemContext(
      removedCount,
      compressedCount,
      summary,
    )
    const lastSystemIdx = systemMessages.length - 1
    const lastSystem = systemMessages[lastSystemIdx]

    // Append context to last system message
    const updatedSystem: Message = {
      ...lastSystem,
      content:
        typeof lastSystem.content === "string" ?
          lastSystem.content + truncationContext
        : lastSystem.content, // Can't append to array content
    }
    newSystemMessages = [
      ...systemMessages.slice(0, lastSystemIdx),
      updatedSystem,
    ]
  } else {
    // No system messages, use marker message
    const marker = createTruncationMarker(
      removedCount,
      compressedCount,
      summary,
    )
    newMessages = [marker, ...preserved]
  }

  const newPayload: ChatCompletionsPayload = {
    ...payload,
    messages: [...newSystemMessages, ...newMessages],
  }

  // Verify the result
  const newBytes = JSON.stringify(newPayload).length
  const newTokenCount = await getTokenCount(newPayload, model)

  // Log single line summary
  let reason = "tokens"
  if (exceedsTokens && exceedsBytes) reason = "tokens+size"
  else if (exceedsBytes) reason = "size"

  const actions: Array<string> = []
  if (removedCount > 0) actions.push(`removed ${removedCount} msgs`)
  if (compressedCount > 0)
    actions.push(`compressed ${compressedCount} tool_results`)
  const actionInfo = actions.length > 0 ? ` (${actions.join(", ")})` : ""

  consola.info(
    `[AutoTruncate:OpenAI] ${reason}: ${originalTokens}→${newTokenCount.input} tokens, `
      + `${Math.round(originalBytes / 1024)}→${Math.round(newBytes / 1024)}KB${actionInfo}`,
  )

  // Warn if still over limit (shouldn't happen with correct algorithm)
  if (newBytes > byteLimit) {
    consola.warn(
      `[AutoTruncate:OpenAI] Result still over byte limit (${Math.round(newBytes / 1024)}KB > ${Math.round(byteLimit / 1024)}KB)`,
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
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 */
export function createTruncationResponseMarkerOpenAI(
  result: OpenAIAutoTruncateResult,
): string {
  if (!result.wasCompacted) return ""

  const reduction = result.originalTokens - result.compactedTokens
  const percentage = Math.round((reduction / result.originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${result.removedMessageCount} messages removed, `
    + `${result.originalTokens} → ${result.compactedTokens} tokens (${percentage}% reduction)]`
  )
}
