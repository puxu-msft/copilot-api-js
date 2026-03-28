import type { Model } from "~/lib/models/client"
import type { ContentBlock, ContentBlockParam, MessageParam, MessagesPayload } from "~/types/api/anthropic"

import type { AutoTruncateConfig } from "../../auto-truncate"

import {
  LARGE_TOOL_RESULT_THRESHOLD,
  compressCompactedReadResult,
  compressToolResultContent,
  computeSafetyMargin,
  getLearnedLimits,
} from "../../auto-truncate"
import { processToolBlocks } from "../sanitize"
import { ensureAnthropicStartsWithUser } from "./tool-utils"
import { estimateMessageTokens } from "./token-counting"
import { isImmutableThinkingAssistantMessage } from "../thinking-immutability"

/**
 * Strip thinking/redacted_thinking blocks from old assistant messages.
 */
export function stripThinkingBlocks(
  messages: Array<MessageParam>,
  preserveRecentCount: number,
): { messages: Array<MessageParam>; strippedCount: number } {
  const n = messages.length
  const stripBefore = Math.max(0, n - preserveRecentCount)
  let strippedCount = 0

  const result = messages.map((msg, i) => {
    if (i >= stripBefore || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg
    }

    if (isImmutableThinkingAssistantMessage(msg)) {
      return msg
    }

    const hasThinking = msg.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
    if (!hasThinking) return msg

    const filtered = msg.content.filter((block): block is ContentBlock => {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        strippedCount++
        return false
      }
      return true
    })

    if (filtered.length === 0) {
      return { ...msg, content: [{ type: "text" as const, text: "" }] }
    }

    return { ...msg, content: filtered }
  })

  return { messages: result, strippedCount }
}

function compressToolResultBlock(block: ContentBlockParam): ContentBlockParam {
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
 * Smart compression strategy for Anthropic format.
 */
export function smartCompressToolResults(
  messages: Array<MessageParam>,
  tokenLimit: number,
  preservePercent: number,
): {
  messages: Array<MessageParam>
  compressedCount: number
  compressThresholdIndex: number
} {
  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(messages[i])
  }

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

  const result: Array<MessageParam> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (i < thresholdIndex && msg.role === "user" && Array.isArray(msg.content)) {
      let hadCompression = false
      const compressedContent = msg.content.map((block) => {
        if (
          block.type === "tool_result"
          && typeof block.content === "string"
          && block.content.length > LARGE_TOOL_RESULT_THRESHOLD
        ) {
          compressedCount++
          hadCompression = true
          return compressToolResultBlock(block)
        }
        if (block.type === "text" && block.text.length > LARGE_TOOL_RESULT_THRESHOLD) {
          const compressed = compressCompactedReadResult(block.text)
          if (compressed) {
            compressedCount++
            hadCompression = true
            return { ...block, text: compressed }
          }
        }
        return block
      })
      if (hadCompression) {
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

/**
 * Calculate the effective token limit for auto-truncate.
 */
export function calculateTokenLimit(model: Model, config: AutoTruncateConfig): number | undefined {
  if (config.targetTokenLimit !== undefined) {
    return config.targetTokenLimit
  }

  const learned = getLearnedLimits(model.id)
  if (learned) {
    const margin = computeSafetyMargin(learned.sampleCount)
    return Math.floor(learned.tokenLimit * (1 - margin))
  }

  const rawTokenLimit =
    model.capabilities?.limits?.max_context_window_tokens ?? model.capabilities?.limits?.max_prompt_tokens

  if (rawTokenLimit === undefined) return undefined

  return Math.floor(rawTokenLimit * (1 - config.safetyMarginPercent / 100))
}

interface PreserveSearchParams {
  messages: Array<MessageParam>
  systemTokens: number
  tokenLimit: number
}

export function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const { messages, systemTokens, tokenLimit } = params

  if (messages.length === 0) return 0

  const markerTokens = 50
  const availableTokens = tokenLimit - systemTokens - markerTokens

  if (availableTokens <= 0) {
    return messages.length
  }

  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(messages[i])
  }

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

export function generateRemovedMessagesSummary(removedMessages: Array<MessageParam>): string {
  const toolCalls: Array<string> = []
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const msg of removedMessages) {
    if (msg.role === "user") {
      userMessageCount++
    } else {
      assistantMessageCount++
    }

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

export function addCompressionNotice(payload: MessagesPayload, compressedCount: number): MessagesPayload {
  const notice =
    `[CONTEXT NOTE]\n`
    + `${compressedCount} large tool_result blocks have been compressed to reduce context size.\n`
    + `The compressed results show the beginning and end of the content with an omission marker.\n`
    + `If you need the full content, you can re-read the file or re-run the tool.\n`
    + `[END NOTE]\n\n`

  let newSystem: MessagesPayload["system"]
  if (typeof payload.system === "string") {
    newSystem = notice + payload.system
  } else if (Array.isArray(payload.system)) {
    newSystem = [{ type: "text" as const, text: notice }, ...payload.system]
  } else {
    newSystem = notice
  }

  return { ...payload, system: newSystem }
}

export function createTruncationSystemContext(
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

export function createTruncationMarker(
  removedCount: number,
  compressedCount: number,
  summary: string,
): MessageParam {
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
 * Clean up truncated messages after preserve slicing.
 */
export function cleanupMessages(messages: Array<MessageParam>): Array<MessageParam> {
  let cleanedMessages = messages
  let pass = processToolBlocks(cleanedMessages, undefined)
  cleanedMessages = pass.messages
  cleanedMessages = ensureAnthropicStartsWithUser(cleanedMessages)
  pass = processToolBlocks(cleanedMessages, undefined)
  return pass.messages
}
