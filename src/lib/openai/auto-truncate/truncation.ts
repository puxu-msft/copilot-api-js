import type { ChatCompletionsPayload, Message } from "~/types/api/openai-chat-completions"

import { LARGE_TOOL_RESULT_THRESHOLD, compressToolResultContent } from "../../auto-truncate"
import {
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
} from "../orphan-filter"
import { calculateCumulativeSums, estimateMessageTokens } from "./token-counting"

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
 * Smart compression strategy for OpenAI format.
 */
export function smartCompressToolResults(
  messages: Array<Message>,
  tokenLimit: number,
  preservePercent: number,
): {
  messages: Array<Message>
  compressedCount: number
  compressThresholdIndex: number
} {
  const n = messages.length
  const { cumTokens } = calculateCumulativeSums(messages)
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

interface PreserveSearchParams {
  messages: Array<Message>
  systemTokens: number
  tokenLimit: number
}

/**
 * Find the optimal index from which to preserve messages.
 * Uses binary search with pre-calculated cumulative sums.
 */
export function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const { messages, systemTokens, tokenLimit } = params

  if (messages.length === 0) return 0

  const markerTokens = 50
  const availableTokens = tokenLimit - systemTokens - markerTokens

  if (availableTokens <= 0) {
    return messages.length
  }

  const n = messages.length
  const { cumTokens } = calculateCumulativeSums(messages)

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
    const displayTools =
      uniqueTools.length > 5 ? [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`] : uniqueTools
    parts.push(`Tools used: ${displayTools.join(", ")}`)
  }

  return parts.join(". ")
}

/**
 * Add a compression notice to the system message.
 */
export function addCompressionNotice(
  payload: ChatCompletionsPayload,
  compressedCount: number,
): ChatCompletionsPayload {
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
export function createTruncationSystemContext(
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
export function createTruncationMarker(
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
 * Extract system token approximation from OpenAI messages.
 */
export function estimateSystemTokens(messages: Array<Message>): number {
  const { systemMessages } = extractOpenAISystemMessages(messages)
  return systemMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}
