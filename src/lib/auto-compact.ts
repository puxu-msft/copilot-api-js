import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "~/lib/tokenizer"

/** Configuration for auto-compact behavior */
export interface AutoCompactConfig {
  /** Target tokens to preserve at the end (default: 120000 to stay within 128k limit) */
  targetTokens: number
  /** Safety margin percentage to account for token counting differences (default: 2) */
  safetyMarginPercent: number
  /** Maximum request body size in bytes (default: 500KB to stay within typical limits) */
  maxRequestBodyBytes: number
}

const DEFAULT_CONFIG: AutoCompactConfig = {
  targetTokens: 120000, // Target 120k to stay safely within 128k limit
  safetyMarginPercent: 2, // Small margin for token counting differences
  maxRequestBodyBytes: 500 * 1024, // 500KB limit for request body
}

/** Result of auto-compact operation */
export interface AutoCompactResult {
  /** The compacted payload (or original if no compaction needed) */
  payload: ChatCompletionsPayload
  /** Whether compaction was performed */
  wasCompacted: boolean
  /** Original token count */
  originalTokens: number
  /** Token count after compaction */
  compactedTokens: number
  /** Number of messages that were removed */
  removedMessageCount: number
}

/**
 * Check if payload needs compaction based on model limits OR request body size.
 * Uses a safety margin to account for token counting differences.
 */
export async function checkNeedsCompaction(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoCompactConfig> = {},
): Promise<{
  needed: boolean
  currentTokens: number
  tokenLimit: number
  currentBytes: number
  byteLimit: number
  reason?: "tokens" | "bytes" | "both"
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const tokenCount = await getTokenCount(payload, model)
  const currentTokens = tokenCount.input
  const rawLimit = model.capabilities?.limits?.max_prompt_tokens ?? 128000
  // Apply safety margin to trigger compaction earlier
  const tokenLimit = Math.floor(rawLimit * (1 - cfg.safetyMarginPercent / 100))

  // Calculate request body size
  const currentBytes = JSON.stringify(payload).length
  const byteLimit = cfg.maxRequestBodyBytes

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
 * Calculate approximate token count for a single message.
 * This is a fast estimation for splitting decisions.
 */
function estimateMessageTokens(message: Message): number {
  let text = ""
  if (typeof message.content === "string") {
    text = message.content
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") {
        text += part.text
      } else if ("image_url" in part) {
        // Images add significant tokens
        text += part.image_url.url
      }
    }
  }

  // Add tool calls if present
  if (message.tool_calls) {
    text += JSON.stringify(message.tool_calls)
  }

  // Rough estimation: ~4 characters per token + message overhead
  return Math.ceil(text.length / 4) + 10
}

/**
 * Extract system messages from the beginning of the message list.
 */
function extractSystemMessages(messages: Array<Message>): {
  systemMessages: Array<Message>
  remainingMessages: Array<Message>
} {
  const systemMessages: Array<Message> = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === "system" || msg.role === "developer") {
      systemMessages.push(msg)
      i++
    } else {
      break
    }
  }

  return {
    systemMessages,
    remainingMessages: messages.slice(i),
  }
}

/**
 * Extract tool_use ids from assistant messages with tool_calls.
 */
function getToolUseIds(message: Message): Array<string> {
  if (message.role === "assistant" && message.tool_calls) {
    return message.tool_calls.map((tc: ToolCall) => tc.id)
  }
  return []
}

/**
 * Find messages to keep from the end to stay under target tokens.
 * Returns the starting index of messages to preserve.
 */
function findPreserveIndex(
  messages: Array<Message>,
  targetTokens: number,
  systemTokens: number,
): number {
  const availableTokens = targetTokens - systemTokens - 500 // Reserve for truncation marker

  let accumulatedTokens = 0

  // Walk backwards from the end to find initial preserve index
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i])
    if (accumulatedTokens + msgTokens > availableTokens) {
      // This message would put us over - start preserving from next message
      return i + 1
    }
    accumulatedTokens += msgTokens
  }

  // All messages fit
  return 0
}

/**
 * Filter out orphaned tool_result messages that don't have a matching tool_use
 * in the preserved message list. This prevents API errors when truncation
 * separates tool_use/tool_result pairs.
 */
function filterOrphanedToolResults(messages: Array<Message>): Array<Message> {
  // First, collect all tool_use IDs in the message list
  const availableToolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getToolUseIds(msg)) {
      availableToolUseIds.add(id)
    }
  }

  // Filter out tool messages whose tool_call_id doesn't have a matching tool_use
  const filteredMessages: Array<Message> = []
  let removedCount = 0

  for (const msg of messages) {
    if (
      msg.role === "tool"
      && msg.tool_call_id
      && !availableToolUseIds.has(msg.tool_call_id)
    ) {
      // This tool_result has no matching tool_use, skip it
      removedCount++
      continue
    }
    filteredMessages.push(msg)
  }

  if (removedCount > 0) {
    consola.info(
      `Auto-compact: Removed ${removedCount} orphaned tool_result message(s) without matching tool_use`,
    )
  }

  return filteredMessages
}

/**
 * Ensure the message list starts with a user message.
 * If it starts with assistant or tool messages, skip them until we find a user message.
 * This is required because OpenAI API expects conversations to start with user messages
 * (after system messages).
 */
function ensureStartsWithUser(messages: Array<Message>): Array<Message> {
  let startIndex = 0

  // Skip any leading assistant or tool messages
  while (startIndex < messages.length) {
    const msg = messages[startIndex]
    if (msg.role === "user") {
      break
    }
    startIndex++
  }

  if (startIndex > 0) {
    consola.info(
      `Auto-compact: Skipped ${startIndex} leading non-user message(s) to ensure valid sequence`,
    )
  }

  return messages.slice(startIndex)
}

/**
 * Calculate estimated tokens for system messages.
 */
function estimateSystemTokens(systemMessages: Array<Message>): number {
  return systemMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0,
  )
}

/**
 * Create a truncation marker message.
 */
function createTruncationMarker(removedCount: number): Message {
  return {
    role: "user",
    content: `[CONTEXT TRUNCATED: ${removedCount} earlier messages were removed to fit context limits. The conversation continues below.]`,
  }
}

/**
 * Perform auto-compaction on a payload that exceeds token or size limits.
 * This uses simple truncation - no LLM calls required.
 * Uses iterative approach with decreasing target tokens until under limit.
 */
export async function autoCompact(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoCompactConfig> = {},
): Promise<AutoCompactResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Check current token count and body size
  const tokenCount = await getTokenCount(payload, model)
  const originalTokens = tokenCount.input
  const rawLimit = model.capabilities?.limits?.max_prompt_tokens ?? 128000
  const tokenLimit = Math.floor(rawLimit * (1 - cfg.safetyMarginPercent / 100))
  const originalBytes = JSON.stringify(payload).length
  const byteLimit = cfg.maxRequestBodyBytes

  // If we're under both limits, no compaction needed
  if (originalTokens <= tokenLimit && originalBytes <= byteLimit) {
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  // Determine the reason for compaction
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
    `Auto-compact: Exceeds ${reason} limit (${originalTokens} tokens, ${Math.round(originalBytes / 1024)}KB), truncating...`,
  )

  // Extract system messages (always preserve them)
  const { systemMessages, remainingMessages } = extractSystemMessages(
    payload.messages,
  )

  const systemTokens = estimateSystemTokens(systemMessages)
  consola.debug(
    `Auto-compact: ${systemMessages.length} system messages (~${systemTokens} tokens)`,
  )

  // Iteratively try decreasing targets until we fit under the limit
  const MAX_ITERATIONS = 5
  const MIN_TARGET = 20000
  let currentTarget = Math.min(cfg.targetTokens, tokenLimit)
  let lastResult: AutoCompactResult | null = null

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const result = await tryCompactWithTarget({
      payload,
      model,
      systemMessages,
      remainingMessages,
      systemTokens,
      targetTokens: currentTarget,
      limit: tokenLimit,
      originalTokens,
    })

    if (!result.wasCompacted) {
      // Could not compact (e.g., all messages filtered out)
      return result
    }

    lastResult = result

    // Check if we're under BOTH limits (tokens and bytes)
    const resultBytes = JSON.stringify(result.payload).length
    const underTokenLimit = result.compactedTokens <= tokenLimit
    const underByteLimit = resultBytes <= byteLimit

    if (underTokenLimit && underByteLimit) {
      consola.info(
        `Auto-compact: ${originalTokens} → ${result.compactedTokens} tokens, `
          + `${Math.round(originalBytes / 1024)}KB → ${Math.round(resultBytes / 1024)}KB `
          + `(removed ${result.removedMessageCount} messages)`,
      )
      return result
    }

    // Still over limit, try more aggressive target
    const tokenStatus =
      underTokenLimit ? "OK" : `${result.compactedTokens} > ${tokenLimit}`
    const byteStatus =
      underByteLimit ? "OK" : (
        `${Math.round(resultBytes / 1024)}KB > ${Math.round(byteLimit / 1024)}KB`
      )
    consola.warn(
      `Auto-compact: Still over limit (tokens: ${tokenStatus}, size: ${byteStatus}), trying more aggressive truncation`,
    )

    currentTarget = Math.floor(currentTarget * 0.7)
    if (currentTarget < MIN_TARGET) {
      consola.error("Auto-compact: Cannot reduce further, target too low")
      return result
    }
  }

  // Exhausted iterations, return last result
  consola.error(
    `Auto-compact: Exhausted ${MAX_ITERATIONS} iterations, returning best effort`,
  )
  return (
    lastResult ?? {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  )
}

/**
 * Helper to attempt compaction with a specific target token count.
 */
async function tryCompactWithTarget(opts: {
  payload: ChatCompletionsPayload
  model: Model
  systemMessages: Array<Message>
  remainingMessages: Array<Message>
  systemTokens: number
  targetTokens: number
  limit: number
  originalTokens: number
}): Promise<AutoCompactResult> {
  const {
    payload,
    model,
    systemMessages,
    remainingMessages,
    systemTokens,
    targetTokens,
    originalTokens,
  } = opts

  // Find where to start preserving messages
  const preserveIndex = findPreserveIndex(
    remainingMessages,
    targetTokens,
    systemTokens,
  )

  // If we need to keep all messages, we can't help
  if (preserveIndex === 0) {
    consola.warn(
      "Auto-compact: Cannot truncate further without losing all conversation history",
    )
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  const removedMessages = remainingMessages.slice(0, preserveIndex)
  let preservedMessages = remainingMessages.slice(preserveIndex)

  // Filter out orphaned tool_result messages that don't have matching tool_use
  preservedMessages = filterOrphanedToolResults(preservedMessages)

  // Ensure the preserved messages start with a user message
  preservedMessages = ensureStartsWithUser(preservedMessages)

  // After filtering, we may need to filter orphaned tool_results again
  preservedMessages = filterOrphanedToolResults(preservedMessages)

  // If all messages were filtered out, we can't proceed with compaction
  if (preservedMessages.length === 0) {
    consola.warn(
      "Auto-compact: All messages were filtered out after cleanup, cannot compact",
    )
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  consola.debug(
    `Auto-compact: Removing ${removedMessages.length} messages, keeping ${preservedMessages.length}`,
  )

  // Build the truncation marker
  const truncationMarker = createTruncationMarker(removedMessages.length)

  // Build new payload
  const newPayload: ChatCompletionsPayload = {
    ...payload,
    messages: [...systemMessages, truncationMarker, ...preservedMessages],
  }

  // Verify the new token count
  const newTokenCount = await getTokenCount(newPayload, model)

  return {
    payload: newPayload,
    wasCompacted: true,
    originalTokens,
    compactedTokens: newTokenCount.input,
    removedMessageCount: removedMessages.length,
  }
}

/**
 * Create a marker to append to responses indicating auto-compaction occurred.
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
