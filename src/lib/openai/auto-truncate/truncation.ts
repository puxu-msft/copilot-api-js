import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"

import { compressToolResultContent } from "../../auto-truncate"
import {
  //
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
} from "../orphan-filter"
import { estimateMessageTokens } from "./token-counting"

/**
 * Clean up orphaned tool messages and ensure valid conversation start.
 * Loops until stable since each pass may create new orphans.
 */
export function cleanupMessages(messages: Array<Message>): Array<Message> {
  let result = messages
  let prevLength: number
  do {
    prevLength = result.length
    result = filterOpenAIOrphanedToolResults(result)
    result = filterOpenAIOrphanedToolUse(result)
    result = ensureOpenAIStartsWithUser(result)
  } while (result.length !== prevLength)
  return result
}

/**
 * Build cumulative-from-end token sums from precomputed per-message counts.
 * `cum[i]` = sum of tokens for messages[i..n-1]; `cum[n]` = 0.
 */
function cumulativeFromPerMessage(perMessageTokens: Array<number>, n: number): Array<number> {
  const cumTokens = Array.from<number>({ length: n + 1 }).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + (perMessageTokens[i] ?? 0)
  }
  return cumTokens
}

/**
 * Smart compression strategy for OpenAI format.
 */
export function smartCompressToolResults(
  messages: Array<Message>,
  tokenLimit: number,
  preservePercent: number,
  perMessageTokens: Array<number>,
  threshold: number,
): {
  messages: Array<Message>
  compressedCount: number
  compressThresholdIndex: number
} {
  const n = messages.length
  const cumTokens = cumulativeFromPerMessage(perMessageTokens, n)
  const preserveTokenLimit = Math.floor(tokenLimit * preservePercent)

  let thresholdIndex = n
  for (let i = n - 1; i >= 0; i--) {
    if (cumTokens[i] > preserveTokenLimit) {
      thresholdIndex = i + 1
      break
    }
    thresholdIndex = i
  }

  if (thresholdIndex >= n) {
    return { messages, compressedCount: 0, compressThresholdIndex: n }
  }

  const result: Array<Message> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (i < thresholdIndex && msg.role === "tool" && typeof msg.content === "string" && msg.content.length > threshold) {
      compressedCount++
      result.push({
        ...msg,
        content: compressToolResultContent(msg.content, threshold),
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

interface PreserveSearchParams {
  messages: Array<Message>
  /**
   * Fixed (non-conversation) token overhead — system messages + tools. Subtracted
   * from the limit so the preserve boundary accounts for tools too (see the
   * Anthropic twin). Ignoring tools leaves a many-tool payload over the limit.
   */
  fixedOverheadTokens: number
  tokenLimit: number
  /**
   * Per-message token counts in the SAME caliber as `tokenLimit` (gpt tokenizer).
   * Precomputed by the caller via `getPerMessageTokenCounts`. See the Anthropic
   * twin for the rationale — char/4 here would misplace the preserve boundary.
   */
  perMessageTokens: Array<number>
}

/**
 * Find the optimal index from which to preserve messages.
 * Uses binary search with pre-calculated cumulative sums.
 */
export function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const { messages, fixedOverheadTokens, tokenLimit, perMessageTokens } = params

  if (messages.length === 0) return 0

  // Reserve headroom for the truncation context/marker injected after this search
  // (see the Anthropic twin). 160 tokens covers the measured upper bound with margin.
  const contextReserveTokens = 160
  const availableTokens = tokenLimit - fixedOverheadTokens - contextReserveTokens

  if (availableTokens <= 0) {
    return messages.length
  }

  const n = messages.length
  const cumTokens = cumulativeFromPerMessage(perMessageTokens, n)

  let left = 0
  let right = n

  while (left < right) {
    const mid = (left + right) >>> 1
    if (cumTokens[mid] <= availableTokens) {
      right = mid
    } else {
      left = mid + 1
    }
  }

  return left
}

/**
 * Generate a summary of removed messages for context.
 */
export function generateRemovedMessagesSummary(removedMessages: Array<Message>): string {
  const toolCalls: Array<string> = []
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const msg of removedMessages) {
    if (msg.role === "user") {
      userMessageCount++
    } else if (msg.role === "assistant") {
      assistantMessageCount++
    }

    if (msg.tool_calls) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.function.name) {
          toolCalls.push(toolCall.function.name)
        }
      }
    }
  }

  const parts: Array<string> = []
  if (userMessageCount > 0 || assistantMessageCount > 0) {
    const breakdown = []
    if (userMessageCount > 0) breakdown.push(`${userMessageCount} user`)
    if (assistantMessageCount > 0) breakdown.push(`${assistantMessageCount} assistant`)
    parts.push(`Messages: ${breakdown.join(", ")}`)
  }

  if (toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls)]
    const displayTools = uniqueTools.length > 5 ? [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`] : uniqueTools
    parts.push(`Tools used: ${displayTools.join(", ")}`)
  }

  return parts.join(". ")
}

/**
 * Add a compression notice to the system message.
 */
export function addCompressionNotice(payload: ChatCompletionsPayload, compressedCount: number): ChatCompletionsPayload {
  const notice =
    `\n\n[CONTEXT NOTE]\n`
    + `${compressedCount} large tool results have been compressed to reduce context size.\n`
    + `The compressed results show the beginning and end of the content with an omission marker.\n`
    + `If you need the full content, you can re-read the file or re-run the tool.\n`
    + `[END NOTE]`

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
export function createTruncationSystemContext(removedCount: number, compressedCount: number, summary: string): string {
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

  context += `If you need earlier context, ask the user or check available tools for conversation history access.\n` + `[END CONTEXT]`

  return context
}

/** Create a truncation marker message (fallback when no system message) */
export function createTruncationMarker(removedCount: number, compressedCount: number, summary: string): Message {
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
 * Extract system token approximation from OpenAI messages.
 */
export function estimateSystemTokens(messages: Array<Message>): number {
  const { systemMessages } = extractOpenAISystemMessages(messages)
  return systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}
