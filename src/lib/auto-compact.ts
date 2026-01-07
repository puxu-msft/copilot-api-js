import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "~/lib/tokenizer"

/** Configuration for auto-compact behavior */
export interface AutoCompactConfig {
  /** Target tokens to preserve at the end (default: 100000 to leave room for output) */
  targetTokens: number
  /** Safety margin percentage to account for token counting differences (default: 10) */
  safetyMarginPercent: number
}

const DEFAULT_CONFIG: AutoCompactConfig = {
  targetTokens: 100000, // Leave ~28k for output on 128k models
  safetyMarginPercent: 10,
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
 * Check if payload needs compaction based on model limits.
 * Uses a safety margin to account for token counting differences.
 */
export async function checkNeedsCompaction(
  payload: ChatCompletionsPayload,
  model: Model,
  safetyMarginPercent = 10,
): Promise<{ needed: boolean; currentTokens: number; limit: number }> {
  const tokenCount = await getTokenCount(payload, model)
  const currentTokens = tokenCount.input
  const rawLimit = model.capabilities.limits.max_prompt_tokens ?? 128000
  // Apply safety margin to trigger compaction earlier
  const limit = Math.floor(rawLimit * (1 - safetyMarginPercent / 100))

  return {
    needed: currentTokens > limit,
    currentTokens,
    limit,
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

  // Walk backwards from the end
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
 * Perform auto-compaction on a payload that exceeds token limits.
 * This uses simple truncation - no LLM calls required.
 */
export async function autoCompact(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoCompactConfig> = {},
): Promise<AutoCompactResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Check current token count
  const tokenCount = await getTokenCount(payload, model)
  const originalTokens = tokenCount.input
  const rawLimit = model.capabilities.limits.max_prompt_tokens ?? 128000
  const limit = Math.floor(rawLimit * (1 - cfg.safetyMarginPercent / 100))

  // If we're under the limit, no compaction needed
  if (originalTokens <= limit) {
    return {
      payload,
      wasCompacted: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    }
  }

  consola.info(
    `Auto-compact: ${originalTokens} tokens exceeds limit of ${limit}, truncating...`,
  )

  // Extract system messages (always preserve them)
  const { systemMessages, remainingMessages } = extractSystemMessages(
    payload.messages,
  )

  const systemTokens = estimateSystemTokens(systemMessages)
  consola.debug(
    `Auto-compact: ${systemMessages.length} system messages (~${systemTokens} tokens)`,
  )

  // Use the smaller of targetTokens or the actual limit
  const effectiveTarget = Math.min(cfg.targetTokens, limit)

  // Find where to start preserving messages
  const preserveIndex = findPreserveIndex(
    remainingMessages,
    effectiveTarget,
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
  const preservedMessages = remainingMessages.slice(preserveIndex)

  consola.info(
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

  consola.info(
    `Auto-compact: Reduced from ${originalTokens} to ${newTokenCount.input} tokens`,
  )

  // If still over limit, try more aggressive truncation
  if (newTokenCount.input > limit) {
    consola.warn(
      `Auto-compact: Still over limit (${newTokenCount.input} > ${limit}), trying more aggressive truncation`,
    )

    // Recursively try with a smaller target
    const aggressiveTarget = Math.floor(effectiveTarget * 0.7)
    if (aggressiveTarget < 20000) {
      consola.error("Auto-compact: Cannot reduce further, target too low")
      return {
        payload: newPayload,
        wasCompacted: true,
        originalTokens,
        compactedTokens: newTokenCount.input,
        removedMessageCount: removedMessages.length,
      }
    }

    return autoCompact(payload, model, {
      ...cfg,
      targetTokens: aggressiveTarget,
    })
  }

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
