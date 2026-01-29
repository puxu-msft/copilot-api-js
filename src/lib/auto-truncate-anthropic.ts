/**
 * Auto-truncate module for Anthropic-style messages.
 *
 * This module handles automatic truncation of Anthropic message format
 * when it exceeds token or byte limits.
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Considers both token and byte limits
 * - Preserves system messages
 * - Filters orphaned tool_result and tool_use messages
 * - Smart compression of old tool_result content (e.g., Read tool results)
 */

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"
import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "~/types/api/anthropic"

import { state } from "~/lib/state"
import { countTextTokens } from "~/lib/tokenizer"

import type { AutoTruncateConfig } from "./auto-truncate-common"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  getEffectiveByteLimitBytes,
  getEffectiveTokenLimit,
} from "./auto-truncate-common"

// ============================================================================
// Result Types
// ============================================================================

export interface AnthropicAutoTruncateResult {
  payload: AnthropicMessagesPayload
  wasCompacted: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
}

// ============================================================================
// Token Counting (using official Anthropic tokenizer)
// ============================================================================

/**
 * Convert Anthropic message content to text for token counting.
 */
function contentToText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") {
    return content
  }

  const parts: Array<string> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        parts.push(block.text)
        break
      }
      case "tool_use": {
        parts.push(`[tool_use: ${block.name}]`, JSON.stringify(block.input))
        break
      }
      case "tool_result": {
        if (typeof block.content === "string") {
          parts.push(block.content)
        } else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner.type === "text") {
              parts.push(inner.text)
            }
            // Images are not counted as text tokens
          }
        }
        break
      }
      case "thinking": {
        parts.push(block.thinking)
        break
      }
      default: {
        // Images and other binary content are not counted as text tokens
        break
      }
    }
  }

  return parts.join("\n")
}

/**
 * Estimate tokens for a message (fast, synchronous).
 * Uses ~4 chars per token approximation for internal calculations.
 * The final result is verified with the accurate tokenizer.
 */
function estimateMessageTokens(msg: AnthropicMessage): number {
  const text = contentToText(msg.content)
  // ~4 chars per token + message framing overhead
  return Math.ceil(text.length / 4) + 4
}

/**
 * Count tokens for an Anthropic message using the model's tokenizer.
 */
async function countMessageTokens(
  msg: AnthropicMessage,
  model: Model,
): Promise<number> {
  const text = contentToText(msg.content)
  // Add message framing overhead (role + structure)
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count tokens for system prompt.
 */
async function countSystemTokens(
  system: AnthropicMessagesPayload["system"],
  model: Model,
): Promise<number> {
  if (!system) return 0
  if (typeof system === "string") {
    return (await countTextTokens(system, model)) + 4
  }
  const text = system.map((block) => block.text).join("\n")
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count total tokens for the payload using the model's tokenizer.
 */
async function countTotalTokens(
  payload: AnthropicMessagesPayload,
  model: Model,
): Promise<number> {
  let total = await countSystemTokens(payload.system, model)
  for (const msg of payload.messages) {
    total += await countMessageTokens(msg, model)
  }
  // Add overhead for tools
  if (payload.tools) {
    const toolsText = JSON.stringify(payload.tools)
    total += await countTextTokens(toolsText, model)
  }
  return total
}

// ============================================================================
// Message Utilities
// ============================================================================

function getMessageBytes(msg: AnthropicMessage): number {
  return JSON.stringify(msg).length
}

/**
 * Get tool_use IDs from an assistant message.
 */
function getToolUseIds(msg: AnthropicMessage): Array<string> {
  if (msg.role !== "assistant") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_use") {
      ids.push(block.id)
    }
  }
  return ids
}

/**
 * Get tool_result IDs from a user message.
 */
function getToolResultIds(msg: AnthropicMessage): Array<string> {
  if (msg.role !== "user") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_result") {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Filter orphaned tool_result messages (those without matching tool_use).
 */
function filterOrphanedToolResults(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  // Collect all tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getToolUseIds(msg)) {
      toolUseIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_results from user messages
  const result: Array<AnthropicMessage> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content !== "string") {
      const toolResultIds = getToolResultIds(msg)
      const hasOrphanedToolResult = toolResultIds.some(
        (id) => !toolUseIds.has(id),
      )

      if (hasOrphanedToolResult) {
        // Filter out orphaned tool_result blocks
        const filteredContent = msg.content.filter((block) => {
          if (
            block.type === "tool_result"
            && !toolUseIds.has(block.tool_use_id)
          ) {
            removedCount++
            return false
          }
          return true
        })

        // If all content was tool_results that got removed, skip the message
        if (filteredContent.length === 0) {
          continue
        }

        result.push({ ...msg, content: filteredContent })
        continue
      }
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(
      `[AutoTruncate:Anthropic] Filtered ${removedCount} orphaned tool_result`,
    )
  }

  return result
}

/**
 * Filter orphaned tool_use messages (those without matching tool_result).
 * In Anthropic API, every tool_use must have a corresponding tool_result.
 */
function filterOrphanedToolUse(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  // Collect all tool_result IDs
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getToolResultIds(msg)) {
      toolResultIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_use from assistant messages
  const result: Array<AnthropicMessage> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content !== "string") {
      const msgToolUseIds = getToolUseIds(msg)
      const hasOrphanedToolUse = msgToolUseIds.some(
        (id) => !toolResultIds.has(id),
      )

      if (hasOrphanedToolUse) {
        // Filter out orphaned tool_use blocks
        const filteredContent = msg.content.filter((block) => {
          if (block.type === "tool_use" && !toolResultIds.has(block.id)) {
            removedCount++
            return false
          }
          return true
        })

        // If all content was tool_use that got removed, skip the message
        if (filteredContent.length === 0) {
          continue
        }

        result.push({ ...msg, content: filteredContent })
        continue
      }
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(
      `[AutoTruncate:Anthropic] Filtered ${removedCount} orphaned tool_use`,
    )
  }

  return result
}

/**
 * Ensure messages start with a user message.
 */
function ensureStartsWithUser(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(
      `[AutoTruncate:Anthropic] Skipped ${startIndex} leading non-user messages`,
    )
  }

  return messages.slice(startIndex)
}

// ============================================================================
// Smart Tool Result Compression
// ============================================================================

/** Threshold for large tool_result content (bytes) */
const LARGE_TOOL_RESULT_THRESHOLD = 10000 // 10KB

/** Maximum length for compressed tool_result summary */
const COMPRESSED_SUMMARY_LENGTH = 500

/**
 * Compress a large tool_result content to a summary.
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
 * Compress a tool_result block in an Anthropic message.
 */
function compressToolResultBlock(
  block: AnthropicUserContentBlock,
): AnthropicUserContentBlock {
  if (
    block.type === "tool_result"
    && typeof block.content === "string"
    && block.content.length > LARGE_TOOL_RESULT_THRESHOLD
  ) {
    return {
      ...block,
      content: compressToolResultContent(block.content),
    }
  }
  return block
}

/**
 * Smart compression strategy:
 * 1. Calculate tokens/bytes from the end until reaching preservePercent of limit
 * 2. Messages before that threshold get their tool_results compressed
 * 3. Returns compressed messages and stats
 *
 * @param preservePercent - Percentage of context to preserve uncompressed (0.0-1.0)
 */
function smartCompressToolResults(
  messages: Array<AnthropicMessage>,
  tokenLimit: number,
  byteLimit: number,
  preservePercent: number,
): {
  messages: Array<AnthropicMessage>
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

  // Compress tool_results in messages before threshold
  const result: Array<AnthropicMessage> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (
      i < thresholdIndex
      && msg.role === "user"
      && Array.isArray(msg.content)
    ) {
      // Check if this message has large tool_results
      const hasLargeToolResult = msg.content.some(
        (block) =>
          block.type === "tool_result"
          && typeof block.content === "string"
          && block.content.length > LARGE_TOOL_RESULT_THRESHOLD,
      )

      if (hasLargeToolResult) {
        const compressedContent = msg.content.map((block) => {
          if (
            block.type === "tool_result"
            && typeof block.content === "string"
            && block.content.length > LARGE_TOOL_RESULT_THRESHOLD
          ) {
            compressedCount++
            return compressToolResultBlock(block)
          }
          return block
        })
        result.push({ ...msg, content: compressedContent })
        continue
      }
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
// Limit Calculation
// ============================================================================

interface Limits {
  tokenLimit: number
  byteLimit: number
}

/** Default fallback for when model capabilities are not available */
const DEFAULT_CONTEXT_WINDOW = 200000

function calculateLimits(model: Model, config: AutoTruncateConfig): Limits {
  // Check for dynamic token limit (adjusted based on previous errors)
  const dynamicLimit = getEffectiveTokenLimit(model.id)

  // Use dynamic limit if available, otherwise use model capabilities
  const rawTokenLimit =
    dynamicLimit
    ?? model.capabilities?.limits?.max_context_window_tokens
    ?? model.capabilities?.limits?.max_prompt_tokens
    ?? DEFAULT_CONTEXT_WINDOW

  const tokenLimit = Math.floor(
    rawTokenLimit * (1 - config.safetyMarginPercent / 100),
  )
  const byteLimit = getEffectiveByteLimitBytes()
  return { tokenLimit, byteLimit }
}

// ============================================================================
// Binary Search Algorithm
// ============================================================================

interface PreserveSearchParams {
  messages: Array<AnthropicMessage>
  systemBytes: number
  systemTokens: number
  payloadOverhead: number
  tokenLimit: number
  byteLimit: number
}

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

  // Account for truncation marker
  const markerBytes = 200
  const markerTokens = 50

  const availableTokens = tokenLimit - systemTokens - markerTokens
  const availableBytes = byteLimit - payloadOverhead - systemBytes - markerBytes

  if (availableTokens <= 0 || availableBytes <= 0) {
    return messages.length
  }

  // Pre-calculate cumulative sums from the end
  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)
  const cumBytes: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    const msg = messages[i]
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(msg)
    cumBytes[i] = cumBytes[i + 1] + getMessageBytes(msg) + 1
  }

  // Binary search for the smallest index where both limits are satisfied
  let left = 0
  let right = n

  while (left < right) {
    const mid = (left + right) >>> 1
    if (cumTokens[mid] <= availableTokens && cumBytes[mid] <= availableBytes) {
      right = mid
    } else {
      left = mid + 1
    }
  }

  return left
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Generate a summary of removed messages for context.
 * Extracts key information like tool calls and topics.
 */
function generateRemovedMessagesSummary(
  removedMessages: Array<AnthropicMessage>,
): string {
  const toolCalls: Array<string> = []
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const msg of removedMessages) {
    if (msg.role === "user") {
      userMessageCount++
    } else {
      assistantMessageCount++
    }

    // Extract tool use names
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolCalls.push(block.name)
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
 * Add a compression notice to the system prompt.
 * Informs the model that some tool_result content has been compressed.
 */
function addCompressionNotice(
  payload: AnthropicMessagesPayload,
  compressedCount: number,
): AnthropicMessagesPayload {
  const notice =
    `[CONTEXT NOTE]\n`
    + `${compressedCount} large tool_result blocks have been compressed to reduce context size.\n`
    + `The compressed results show the beginning and end of the content with an omission marker.\n`
    + `If you need the full content, you can re-read the file or re-run the tool.\n`
    + `[END NOTE]\n\n`

  let newSystem: AnthropicMessagesPayload["system"]
  if (typeof payload.system === "string") {
    newSystem = notice + payload.system
  } else if (Array.isArray(payload.system)) {
    newSystem = [{ type: "text" as const, text: notice }, ...payload.system]
  } else {
    newSystem = notice
  }

  return { ...payload, system: newSystem }
}

/**
 * Create truncation context to prepend to system prompt.
 */
function createTruncationSystemContext(
  removedCount: number,
  compressedCount: number,
  summary: string,
): string {
  let context = `[CONVERSATION CONTEXT]\n`

  if (removedCount > 0) {
    context += `${removedCount} earlier messages have been removed due to context window limits.\n`
  }

  if (compressedCount > 0) {
    context += `${compressedCount} large tool_result blocks have been compressed.\n`
  }

  if (summary) {
    context += `Summary of removed content: ${summary}\n`
  }

  context +=
    `If you need earlier context, ask the user or check available tools for conversation history access.\n`
    + `[END CONTEXT]\n\n`

  return context
}

/**
 * Create a truncation marker message (fallback when no system prompt).
 */
function createTruncationMarker(
  removedCount: number,
  compressedCount: number,
  summary: string,
): AnthropicMessage {
  const parts: Array<string> = []

  if (removedCount > 0) {
    parts.push(`${removedCount} earlier messages removed`)
  }
  if (compressedCount > 0) {
    parts.push(`${compressedCount} tool_result blocks compressed`)
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
 * Perform auto-truncation on an Anthropic payload that exceeds limits.
 */
export async function autoTruncateAnthropic(
  payload: AnthropicMessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<AnthropicAutoTruncateResult> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  // Measure original size
  const payloadJson = JSON.stringify(payload)
  const originalBytes = payloadJson.length
  const originalTokens = await countTotalTokens(payload, model)

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

  // Step 1: Smart compress old tool_results (if enabled)
  // Compress tool_results in messages that are beyond the preserve threshold
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
    const compressedTokens = await countTotalTokens(compressedPayload, model)

    if (compressedTokens <= tokenLimit && compressedBytes <= byteLimit) {
      // Log single line summary
      let reason = "tokens"
      if (exceedsTokens && exceedsBytes) reason = "tokens+size"
      else if (exceedsBytes) reason = "size"
      consola.info(
        `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${compressedTokens} tokens, `
          + `${Math.round(originalBytes / 1024)}→${Math.round(compressedBytes / 1024)}KB `
          + `(compressed ${compressedCount} tool_results)`,
      )

      // Add compression notice to system prompt
      const noticePayload = addCompressionNotice(
        compressedPayload,
        compressedCount,
      )

      return {
        payload: noticePayload,
        wasCompacted: true,
        originalTokens,
        compactedTokens: await countTotalTokens(noticePayload, model),
        removedMessageCount: 0,
      }
    }
  }

  // Step 2: Compression wasn't enough (or disabled), proceed with message removal
  // Use working messages (compressed if enabled, original otherwise)

  // Calculate system message size (Anthropic has separate system field)
  const systemBytes = payload.system ? JSON.stringify(payload.system).length : 0
  const systemTokens = await countSystemTokens(payload.system, model)

  // Calculate overhead (use compressed messages size)
  const messagesJson = JSON.stringify(workingMessages)
  const workingBytes = JSON.stringify({
    ...payload,
    messages: workingMessages,
  }).length
  const payloadOverhead = workingBytes - messagesJson.length

  consola.debug(
    `[AutoTruncate:Anthropic] overhead=${Math.round(payloadOverhead / 1024)}KB, `
      + `system=${Math.round(systemBytes / 1024)}KB`,
  )

  // Find optimal preserve index on working messages
  const preserveIndex = findOptimalPreserveIndex({
    messages: workingMessages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
  })

  // Check if we can compact
  if (preserveIndex === 0) {
    consola.warn(
      "[AutoTruncate:Anthropic] Cannot truncate, system messages too large",
    )
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  if (preserveIndex >= workingMessages.length) {
    consola.warn("[AutoTruncate:Anthropic] Would need to remove all messages")
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Build preserved messages from working (compressed) messages
  let preserved = workingMessages.slice(preserveIndex)

  // Clean up the message list - filter both orphaned tool_result and tool_use
  preserved = filterOrphanedToolResults(preserved)
  preserved = filterOrphanedToolUse(preserved)
  preserved = ensureStartsWithUser(preserved)
  // Run again after ensuring starts with user, in case we skipped messages
  preserved = filterOrphanedToolResults(preserved)
  preserved = filterOrphanedToolUse(preserved)

  if (preserved.length === 0) {
    consola.warn(
      "[AutoTruncate:Anthropic] All messages filtered out after cleanup",
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
  // Use original messages for summary (uncompressed content is more informative)
  const removedMessages = payload.messages.slice(0, preserveIndex)
  const removedCount = workingMessages.length - preserved.length
  const summary = generateRemovedMessagesSummary(removedMessages)

  // Build new payload with truncation context
  let newSystem = payload.system
  let newMessages = preserved

  // Prefer adding context to system prompt (cleaner for the model)
  if (payload.system !== undefined) {
    const truncationContext = createTruncationSystemContext(
      removedCount,
      compressedCount,
      summary,
    )
    if (typeof payload.system === "string") {
      newSystem = truncationContext + payload.system
    } else if (Array.isArray(payload.system)) {
      // Prepend as first text block
      newSystem = [
        { type: "text" as const, text: truncationContext },
        ...payload.system,
      ]
    }
  } else {
    // No system prompt, use marker message
    const marker = createTruncationMarker(
      removedCount,
      compressedCount,
      summary,
    )
    newMessages = [marker, ...preserved]
  }

  const newPayload: AnthropicMessagesPayload = {
    ...payload,
    system: newSystem,
    messages: newMessages,
  }

  // Verify the result
  const newBytes = JSON.stringify(newPayload).length
  const newTokens = await countTotalTokens(newPayload, model)

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
    `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${newTokens} tokens, `
      + `${Math.round(originalBytes / 1024)}→${Math.round(newBytes / 1024)}KB${actionInfo}`,
  )

  // Warn if still over limit
  if (newBytes > byteLimit || newTokens > tokenLimit) {
    consola.warn(
      `[AutoTruncate:Anthropic] Result still over limit `
        + `(${newTokens} tokens, ${Math.round(newBytes / 1024)}KB)`,
    )
  }

  return {
    payload: newPayload,
    wasCompacted: true,
    originalTokens,
    compactedTokens: newTokens,
    removedMessageCount: removedCount,
  }
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 */
export function createTruncationResponseMarkerAnthropic(
  result: AnthropicAutoTruncateResult,
): string {
  if (!result.wasCompacted) return ""

  const reduction = result.originalTokens - result.compactedTokens
  const percentage = Math.round((reduction / result.originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${result.removedMessageCount} messages removed, `
    + `${result.originalTokens} → ${result.compactedTokens} tokens (${percentage}% reduction)]`
  )
}

/**
 * Check if payload needs compaction.
 */
export async function checkNeedsCompactionAnthropic(
  payload: AnthropicMessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<{
  needed: boolean
  currentTokens: number
  tokenLimit: number
  currentBytes: number
  byteLimit: number
  reason?: "tokens" | "bytes" | "both"
}> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  const currentTokens = await countTotalTokens(payload, model)
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
