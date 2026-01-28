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
 */

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"
import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/types/api/anthropic"

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
// Token Estimation
// ============================================================================

/**
 * Estimate tokens for Anthropic message content.
 * Uses ~4 chars per token as approximation.
 */
function estimateContentTokens(content: AnthropicMessage["content"]): number {
  let charCount = 0

  if (typeof content === "string") {
    charCount = content.length
  } else if (Array.isArray(content)) {
    for (const block of content) {
      switch (block.type) {
        case "text": {
          charCount += block.text.length
          break
        }
        case "tool_use": {
          charCount += JSON.stringify(block.input).length + block.name.length
          break
        }
        case "tool_result": {
          if (typeof block.content === "string") {
            charCount += block.content.length
          } else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              charCount +=
                inner.type === "text" ?
                  inner.text.length
                : Math.min(inner.source.data.length, 10000)
            }
          }
          break
        }
        case "image": {
          charCount += Math.min(block.source.data.length, 10000)
          break
        }
        case "thinking": {
          charCount += block.thinking.length
          break
        }
        default: {
          // Unknown block type, ignore
          break
        }
      }
    }
  }

  // ~4 chars per token + message overhead
  return Math.ceil(charCount / 4) + 10
}

/**
 * Estimate tokens for an Anthropic message.
 */
function estimateMessageTokens(msg: AnthropicMessage): number {
  return estimateContentTokens(msg.content)
}

/**
 * Estimate tokens for system prompt.
 */
function estimateSystemTokens(
  system: AnthropicMessagesPayload["system"],
): number {
  if (!system) return 0
  if (typeof system === "string") {
    return Math.ceil(system.length / 4) + 10
  }
  let charCount = 0
  for (const block of system) {
    charCount += block.text.length
  }
  return Math.ceil(charCount / 4) + 10
}

/**
 * Estimate total tokens for the payload.
 */
function estimateTotalTokens(payload: AnthropicMessagesPayload): number {
  let total = estimateSystemTokens(payload.system)
  for (const msg of payload.messages) {
    total += estimateMessageTokens(msg)
  }
  // Add overhead for tools
  if (payload.tools) {
    total += Math.ceil(JSON.stringify(payload.tools).length / 4)
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
 * Create a truncation marker message.
 */
function createTruncationMarker(removedCount: number): AnthropicMessage {
  return {
    role: "user",
    content: `[CONTEXT TRUNCATED: ${removedCount} earlier messages removed to fit context limits]`,
  }
}

/**
 * Perform auto-truncation on an Anthropic payload that exceeds limits.
 */
export function autoTruncateAnthropic(
  payload: AnthropicMessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): AnthropicAutoTruncateResult {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  // Measure original size
  const payloadJson = JSON.stringify(payload)
  const originalBytes = payloadJson.length
  const originalTokens = estimateTotalTokens(payload)

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
    `[AutoTruncate:Anthropic] Exceeds ${reason} limit `
      + `(${originalTokens} tokens > ${tokenLimit}, ${Math.round(originalBytes / 1024)}KB)`,
  )

  // Calculate system message size (Anthropic has separate system field)
  const systemBytes = payload.system ? JSON.stringify(payload.system).length : 0
  const systemTokens = estimateSystemTokens(payload.system)

  // Calculate overhead
  const messagesJson = JSON.stringify(payload.messages)
  const payloadOverhead = originalBytes - messagesJson.length

  consola.debug(
    `[AutoTruncate:Anthropic] overhead=${Math.round(payloadOverhead / 1024)}KB, `
      + `system=${Math.round(systemBytes / 1024)}KB`,
  )

  // Find optimal preserve index
  const preserveIndex = findOptimalPreserveIndex({
    messages: payload.messages,
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

  if (preserveIndex >= payload.messages.length) {
    consola.warn("[AutoTruncate:Anthropic] Would need to remove all messages")
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Build preserved messages
  let preserved = payload.messages.slice(preserveIndex)

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

  // Build new payload
  const removedCount = payload.messages.length - preserved.length
  const marker = createTruncationMarker(removedCount)

  const newPayload: AnthropicMessagesPayload = {
    ...payload,
    messages: [marker, ...preserved],
  }

  // Verify the result
  const newBytes = JSON.stringify(newPayload).length
  const newTokens = estimateTotalTokens(newPayload)

  consola.info(
    `[AutoTruncate:Anthropic] ${originalTokens} → ${newTokens} tokens, `
      + `${Math.round(originalBytes / 1024)}KB → ${Math.round(newBytes / 1024)}KB `
      + `(removed ${removedCount} messages)`,
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
 * Check if payload needs compaction.
 */
export function checkNeedsCompactionAnthropic(
  payload: AnthropicMessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): {
  needed: boolean
  currentTokens: number
  tokenLimit: number
  currentBytes: number
  byteLimit: number
  reason?: "tokens" | "bytes" | "both"
} {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  const currentTokens = estimateTotalTokens(payload)
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
