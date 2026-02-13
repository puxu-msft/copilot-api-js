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
  AnthropicAssistantContentBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "~/types/api/anthropic"

import {
  ensureAnthropicStartsWithUser,
  filterAnthropicOrphanedToolResults,
  filterAnthropicOrphanedToolUse,
} from "~/lib/anthropic/orphan-filter"
import { countTextTokens } from "~/lib/models/tokenizer"
import { state } from "~/lib/state"
import { bytesToKB } from "~/lib/utils"

import type { AutoTruncateConfig } from "./common"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  LARGE_TOOL_RESULT_THRESHOLD,
  compressCompactedReadResult,
  compressToolResultContent,
  getEffectiveByteLimitBytes,
  getEffectiveTokenLimit,
} from "./common"

// ============================================================================
// Result Types
// ============================================================================

export interface AnthropicAutoTruncateResult {
  payload: AnthropicMessagesPayload
  wasCompacted: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
  /** Processing time in milliseconds */
  processingTimeMs: number
}

// ============================================================================
// Token Counting (using official Anthropic tokenizer)
// ============================================================================

/**
 * Convert Anthropic message content to text for token counting.
 * @param options.includeThinking Whether to include thinking blocks (default: true)
 */
export function contentToText(content: AnthropicMessage["content"], options?: { includeThinking?: boolean }): string {
  if (typeof content === "string") {
    return content
  }

  const includeThinking = options?.includeThinking ?? true
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
        if (includeThinking) {
          parts.push(block.thinking)
        }
        break
      }
      case "redacted_thinking": {
        // Redacted thinking blocks have opaque data, not text — skip for token counting
        break
      }
      case "server_tool_use": {
        parts.push(`[server_tool_use: ${block.name}]`, JSON.stringify(block.input))
        break
      }
      case "web_search_tool_result": {
        parts.push(`[web_search_tool_result]`)
        break
      }
      default: {
        // Handle generic server tool results (e.g., tool_search_tool_result)
        // Cast to Record to bypass type narrowing — API may return unknown block types
        const genericBlock = block as unknown as Record<string, unknown>
        if ("tool_use_id" in genericBlock && genericBlock.type !== "image") {
          parts.push(`[${String(genericBlock.type)}]`)
          break
        }
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
export async function countMessageTokens(
  msg: AnthropicMessage,
  model: Model,
  options?: { includeThinking?: boolean },
): Promise<number> {
  const text = contentToText(msg.content, options)
  // Add message framing overhead (role + structure)
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count tokens for system prompt.
 */
export async function countSystemTokens(system: AnthropicMessagesPayload["system"], model: Model): Promise<number> {
  if (!system) return 0
  if (typeof system === "string") {
    return (await countTextTokens(system, model)) + 4
  }
  const text = system.map((block) => block.text).join("\n")
  return (await countTextTokens(text, model)) + 4
}

/**
 * Count total tokens for the payload using the model's tokenizer.
 * Includes thinking blocks — used by auto-truncate decisions.
 */
export async function countTotalTokens(payload: AnthropicMessagesPayload, model: Model): Promise<number> {
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

/**
 * Count total input tokens for the payload, excluding thinking blocks
 * from assistant messages per Anthropic token counting spec.
 *
 * Per Anthropic docs: "Thinking blocks from previous assistant turns are
 * ignored (don't count toward input tokens)."
 *
 * This function is designed for the /v1/messages/count_tokens endpoint.
 * For auto-truncate decisions, use countTotalTokens instead (which includes
 * thinking blocks since they affect actual payload size).
 */
export async function countTotalInputTokens(payload: AnthropicMessagesPayload, model: Model): Promise<number> {
  let total = await countSystemTokens(payload.system, model)
  for (const msg of payload.messages) {
    // Exclude thinking blocks from assistant messages
    const skipThinking = msg.role === "assistant"
    total += await countMessageTokens(msg, model, {
      includeThinking: !skipThinking,
    })
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

// ============================================================================
// Thinking Block Stripping
// ============================================================================

/**
 * Strip thinking/redacted_thinking blocks from old assistant messages.
 *
 * Per Anthropic docs, thinking blocks from previous turns don't count toward
 * input tokens (for billing), but they DO consume space in the request body.
 * Stripping them from older messages frees up context for actual content.
 *
 * @param messages - The message array to process
 * @param preserveRecentCount - Number of recent messages to preserve (keep thinking in recent messages)
 * @returns Object with stripped messages and count of removed blocks
 */
function stripThinkingBlocks(
  messages: Array<AnthropicMessage>,
  preserveRecentCount: number,
): { messages: Array<AnthropicMessage>; strippedCount: number } {
  const n = messages.length
  const stripBefore = Math.max(0, n - preserveRecentCount)
  let strippedCount = 0

  const result = messages.map((msg, i) => {
    if (i >= stripBefore || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg
    }

    const hasThinking = msg.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
    if (!hasThinking) return msg

    const filtered = msg.content.filter((block): block is AnthropicAssistantContentBlock => {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        strippedCount++
        return false
      }
      return true
    })

    // If all content was thinking blocks, replace with empty text to preserve message structure
    if (filtered.length === 0) {
      return { ...msg, content: [{ type: "text" as const, text: "" }] }
    }

    return { ...msg, content: filtered }
  })

  return { messages: result, strippedCount }
}

// ============================================================================
// Smart Tool Result Compression
// ============================================================================

/**
 * Compress a tool_result block in an Anthropic message.
 */
function compressToolResultBlock(block: AnthropicUserContentBlock): AnthropicUserContentBlock {
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

  // Compress tool_results and compacted text blocks in messages before threshold
  const result: Array<AnthropicMessage> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (i < thresholdIndex && msg.role === "user" && Array.isArray(msg.content)) {
      // Check if this message has compressible blocks
      const hasCompressible = msg.content.some(
        (block) =>
          // Large tool_result blocks
          (block.type === "tool_result"
            && typeof block.content === "string"
            && block.content.length > LARGE_TOOL_RESULT_THRESHOLD)
          // Compacted text blocks (Read/Grep/etc. tool results in system-reminder tags)
          || (block.type === "text"
            && block.text.length > LARGE_TOOL_RESULT_THRESHOLD
            && compressCompactedReadResult(block.text) !== null),
      )

      if (hasCompressible) {
        const compressedContent = msg.content.map((block) => {
          if (
            block.type === "tool_result"
            && typeof block.content === "string"
            && block.content.length > LARGE_TOOL_RESULT_THRESHOLD
          ) {
            compressedCount++
            return compressToolResultBlock(block)
          }
          if (block.type === "text" && block.text.length > LARGE_TOOL_RESULT_THRESHOLD) {
            const compressed = compressCompactedReadResult(block.text)
            if (compressed) {
              compressedCount++
              return { ...block, text: compressed }
            }
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
  // Use explicit target if provided (reactive retry — caller already applied margin)
  if (config.targetTokenLimit !== undefined || config.targetByteLimitBytes !== undefined) {
    return {
      tokenLimit:
        config.targetTokenLimit ?? model.capabilities?.limits?.max_context_window_tokens ?? DEFAULT_CONTEXT_WINDOW,
      byteLimit: config.targetByteLimitBytes ?? getEffectiveByteLimitBytes(),
    }
  }

  // Check for dynamic token limit (adjusted based on previous errors)
  const dynamicLimit = getEffectiveTokenLimit(model.id)

  // Use dynamic limit if available, otherwise use model capabilities
  const rawTokenLimit =
    dynamicLimit
    ?? model.capabilities?.limits?.max_context_window_tokens
    ?? model.capabilities?.limits?.max_prompt_tokens
    ?? DEFAULT_CONTEXT_WINDOW

  const tokenLimit = Math.floor(rawTokenLimit * (1 - config.safetyMarginPercent / 100))
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
  checkTokenLimit: boolean
  checkByteLimit: boolean
}

function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const {
    messages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
    checkTokenLimit,
    checkByteLimit,
  } = params

  if (messages.length === 0) return 0

  // Account for truncation marker
  const markerBytes = 200
  const markerTokens = 50

  const availableTokens = tokenLimit - systemTokens - markerTokens
  const availableBytes = byteLimit - payloadOverhead - systemBytes - markerBytes

  if ((checkTokenLimit && availableTokens <= 0) || (checkByteLimit && availableBytes <= 0)) {
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

  // Binary search for the smallest index where enabled limits are satisfied
  let left = 0
  let right = n

  while (left < right) {
    const mid = (left + right) >>> 1
    const tokensFit = !checkTokenLimit || cumTokens[mid] <= availableTokens
    const bytesFit = !checkByteLimit || cumBytes[mid] <= availableBytes
    if (tokensFit && bytesFit) {
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
function generateRemovedMessagesSummary(removedMessages: Array<AnthropicMessage>): string {
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
        if (block.type === "server_tool_use") {
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
    if (assistantMessageCount > 0) breakdown.push(`${assistantMessageCount} assistant`)
    parts.push(`Messages: ${breakdown.join(", ")}`)
  }

  // Tool calls
  if (toolCalls.length > 0) {
    // Deduplicate and limit
    const uniqueTools = [...new Set(toolCalls)]
    const displayTools =
      uniqueTools.length > 5 ? [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`] : uniqueTools
    parts.push(`Tools used: ${displayTools.join(", ")}`)
  }

  return parts.join(". ")
}

/**
 * Add a compression notice to the system prompt.
 * Informs the model that some tool_result content has been compressed.
 */
function addCompressionNotice(payload: AnthropicMessagesPayload, compressedCount: number): AnthropicMessagesPayload {
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
function createTruncationSystemContext(removedCount: number, compressedCount: number, summary: string): string {
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
function createTruncationMarker(removedCount: number, compressedCount: number, summary: string): AnthropicMessage {
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
  const startTime = performance.now()

  // Helper to build result with timing
  const buildResult = (result: Omit<AnthropicAutoTruncateResult, "processingTimeMs">): AnthropicAutoTruncateResult => ({
    ...result,
    processingTimeMs: Math.round(performance.now() - startTime),
  })

  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  // Measure original size
  const payloadJson = JSON.stringify(payload)
  const originalBytes = payloadJson.length
  const originalTokens = await countTotalTokens(payload, model)

  // Check if compaction is needed
  if (originalTokens <= tokenLimit && originalBytes <= byteLimit) {
    return buildResult({
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Log reason with correct comparison
  const exceedsTokens = originalTokens > tokenLimit
  const exceedsBytes = originalBytes > byteLimit

  // Step 1: Strip thinking blocks from old assistant messages
  // These don't count as input tokens per Anthropic docs, but they consume request body space.
  // Preserve thinking in the last 4 messages (2 exchanges) for context continuity.
  const { messages: thinkingStripped, strippedCount: thinkingStrippedCount } = stripThinkingBlocks(payload.messages, 4)
  let workingMessages = thinkingStripped

  // Check if stripping alone was enough
  if (thinkingStrippedCount > 0) {
    const strippedPayload = { ...payload, messages: workingMessages }
    const strippedBytes = JSON.stringify(strippedPayload).length
    const strippedTokens = await countTotalTokens(strippedPayload, model)

    if (strippedTokens <= tokenLimit && strippedBytes <= byteLimit) {
      let reason = "tokens"
      if (exceedsTokens && exceedsBytes) reason = "tokens+size"
      else if (exceedsBytes) reason = "size"
      const elapsedMs = Math.round(performance.now() - startTime)
      consola.info(
        `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${strippedTokens} tokens, `
          + `${bytesToKB(originalBytes)}→${bytesToKB(strippedBytes)}KB `
          + `(stripped ${thinkingStrippedCount} thinking blocks) [${elapsedMs}ms]`,
      )

      return buildResult({
        payload: strippedPayload,
        wasCompacted: true,
        originalTokens,
        compactedTokens: strippedTokens,
        removedMessageCount: 0,
      })
    }
  }

  // Step 2: Smart compress old tool_results (if enabled)
  // Compress tool_results in messages that are beyond the preserve threshold
  let compressedCount = 0

  if (state.compressToolResults) {
    const compressionResult = smartCompressToolResults(
      workingMessages,
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
      const elapsedMs = Math.round(performance.now() - startTime)
      consola.info(
        `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${compressedTokens} tokens, `
          + `${bytesToKB(originalBytes)}→${bytesToKB(compressedBytes)}KB `
          + `(compressed ${compressedCount} tool_results) [${elapsedMs}ms]`,
      )

      // Add compression notice to system prompt
      const noticePayload = addCompressionNotice(compressedPayload, compressedCount)

      return buildResult({
        payload: noticePayload,
        wasCompacted: true,
        originalTokens,
        compactedTokens: await countTotalTokens(noticePayload, model),
        removedMessageCount: 0,
      })
    }

    // Step 2.5: Compress ALL tool_results (including recent ones)
    // If compressing only old tool_results wasn't enough, try compressing all of them
    // before resorting to message removal
    const allCompression = smartCompressToolResults(
      workingMessages,
      tokenLimit,
      byteLimit,
      0.0, // preservePercent=0 means compress all messages
    )
    if (allCompression.compressedCount > 0) {
      workingMessages = allCompression.messages
      compressedCount += allCompression.compressedCount

      // Check if compressing all was enough
      const allCompressedPayload = { ...payload, messages: workingMessages }
      const allCompressedBytes = JSON.stringify(allCompressedPayload).length
      const allCompressedTokens = await countTotalTokens(allCompressedPayload, model)

      if (allCompressedTokens <= tokenLimit && allCompressedBytes <= byteLimit) {
        let reason = "tokens"
        if (exceedsTokens && exceedsBytes) reason = "tokens+size"
        else if (exceedsBytes) reason = "size"
        const elapsedMs = Math.round(performance.now() - startTime)
        consola.info(
          `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${allCompressedTokens} tokens, `
            + `${bytesToKB(originalBytes)}→${bytesToKB(allCompressedBytes)}KB `
            + `(compressed ${compressedCount} tool_results, including recent) [${elapsedMs}ms]`,
        )

        const noticePayload = addCompressionNotice(allCompressedPayload, compressedCount)

        return buildResult({
          payload: noticePayload,
          wasCompacted: true,
          originalTokens,
          compactedTokens: await countTotalTokens(noticePayload, model),
          removedMessageCount: 0,
        })
      }
    }
  }

  // Step 3: Compression wasn't enough (or disabled), proceed with message removal
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
    `[AutoTruncate:Anthropic] overhead=${bytesToKB(payloadOverhead)}KB, ` + `system=${bytesToKB(systemBytes)}KB`,
  )

  // Find optimal preserve index on working messages
  const preserveIndex = findOptimalPreserveIndex({
    messages: workingMessages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
    checkTokenLimit: cfg.checkTokenLimit,
    checkByteLimit: cfg.checkByteLimit,
  })

  // Check if we can compact
  if (preserveIndex >= workingMessages.length) {
    consola.warn("[AutoTruncate:Anthropic] Would need to remove all messages")
    return buildResult({
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Build preserved messages from working (compressed) messages
  let preserved = workingMessages.slice(preserveIndex)

  // Clean up the message list - filter both orphaned tool_result and tool_use
  preserved = filterAnthropicOrphanedToolResults(preserved)
  preserved = filterAnthropicOrphanedToolUse(preserved)
  preserved = ensureAnthropicStartsWithUser(preserved)
  // Run again after ensuring starts with user, in case we skipped messages
  preserved = filterAnthropicOrphanedToolResults(preserved)
  preserved = filterAnthropicOrphanedToolUse(preserved)

  if (preserved.length === 0) {
    consola.warn("[AutoTruncate:Anthropic] All messages filtered out after cleanup")
    return buildResult({
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
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
    const truncationContext = createTruncationSystemContext(removedCount, compressedCount, summary)
    if (typeof payload.system === "string") {
      newSystem = truncationContext + payload.system
    } else if (Array.isArray(payload.system)) {
      // Prepend as first text block
      newSystem = [{ type: "text" as const, text: truncationContext }, ...payload.system]
    }
  } else {
    // No system prompt, use marker message
    const marker = createTruncationMarker(removedCount, compressedCount, summary)
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
  if (thinkingStrippedCount > 0) actions.push(`stripped ${thinkingStrippedCount} thinking blocks`)
  if (compressedCount > 0) actions.push(`compressed ${compressedCount} tool_results`)
  const actionInfo = actions.length > 0 ? ` (${actions.join(", ")})` : ""

  const elapsedMs = Math.round(performance.now() - startTime)
  consola.info(
    `[AutoTruncate:Anthropic] ${reason}: ${originalTokens}→${newTokens} tokens, `
      + `${bytesToKB(originalBytes)}→${bytesToKB(newBytes)}KB${actionInfo} [${elapsedMs}ms]`,
  )

  // Warn if still over limit
  if (newBytes > byteLimit || newTokens > tokenLimit) {
    consola.warn(
      `[AutoTruncate:Anthropic] Result still over limit ` + `(${newTokens} tokens, ${bytesToKB(newBytes)}KB)`,
    )
  }

  return buildResult({
    payload: newPayload,
    wasCompacted: true,
    originalTokens,
    compactedTokens: newTokens,
    removedMessageCount: removedCount,
  })
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 */
export function createTruncationResponseMarkerAnthropic(result: AnthropicAutoTruncateResult): string {
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

  const exceedsTokens = cfg.checkTokenLimit && currentTokens > tokenLimit
  const exceedsBytes = cfg.checkByteLimit && currentBytes > byteLimit

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
