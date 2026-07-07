import type { Model } from "~/lib/models/client"
import type {
  //
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import type { AutoTruncateConfig } from "../../auto-truncate"

import {
  //
  compressCompactedReadResult,
  compressToolResultContent,
  computeSafetyMargin,
  getLearnedLimits,
} from "../../auto-truncate"
import { processToolBlocks } from "../sanitize"
import { shouldPreserveThinkingBlocks } from "../thinking-protection"
import { ensureAnthropicStartsWithUser } from "./tool-utils"

/**
 * Strip thinking/redacted_thinking blocks from old assistant messages.
 */
export function stripThinkingBlocks(messages: Array<MessageParam>, preserveRecentCount: number): { messages: Array<MessageParam>; strippedCount: number } {
  const n = messages.length
  const stripBefore = Math.max(0, n - preserveRecentCount)
  let strippedCount = 0

  const result = messages.map((msg, i) => {
    if (i >= stripBefore || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg
    }

    if (shouldPreserveThinkingBlocks(msg)) {
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

function compressToolResultBlock(block: ContentBlockParam, threshold: number): ContentBlockParam {
  if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > threshold) {
    return {
      ...block,
      content: compressToolResultContent(block.content, threshold),
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
  perMessageTokens: Array<number>,
  threshold: number,
): {
  messages: Array<MessageParam>
  compressedCount: number
  compressThresholdIndex: number
} {
  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + (perMessageTokens[i] ?? 0)
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
      let hadCompression = false as boolean
      const compressedContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > threshold) {
          compressedCount++
          hadCompression = true
          return compressToolResultBlock(block, threshold)
        }
        if (block.type === "text" && block.text.length > threshold) {
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

  const rawTokenLimit = model.capabilities?.limits?.max_context_window_tokens ?? model.capabilities?.limits?.max_prompt_tokens

  if (rawTokenLimit === undefined) return undefined

  return Math.floor(rawTokenLimit * (1 - config.safetyMarginPercent / 100))
}

interface PreserveSearchParams {
  messages: Array<MessageParam>
  /**
   * Fixed (non-message) token overhead that always ships with the request —
   * system prompt + tools. Subtracted from the limit alongside the marker so the
   * preserve boundary accounts for tools too (a 50-tool payload can be 20k+ tokens
   * of fixed overhead; ignoring it leaves the truncated result over the limit).
   */
  fixedOverheadTokens: number
  tokenLimit: number
  /**
   * Per-message token counts in the SAME caliber as `tokenLimit` (gpt tokenizer).
   * The caller precomputes these via `countPerMessageTokens`. Passing them in
   * (rather than estimating char/4 here) keeps the binary search's cumulative
   * sums caliber-consistent with the limit — otherwise a char/4 undercount can
   * place the preserve boundary at 0 ("everything fits") when the real gpt count
   * still exceeds the limit, yielding a phantom no-op truncation.
   */
  perMessageTokens: Array<number>
}

export function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const { messages, fixedOverheadTokens, tokenLimit, perMessageTokens } = params

  if (messages.length === 0) return 0

  // Reserve headroom for the truncation context/marker that gets injected AFTER
  // this search (createTruncationSystemContext / createTruncationMarker). Measured
  // upper bound is ~84 gpt tokens for a large removed-message summary; 160 leaves
  // margin so the post-injection result stays under the target rather than relying
  // on the strategy's outer retry factor to absorb the overflow.
  const contextReserveTokens = 160
  const availableTokens = tokenLimit - fixedOverheadTokens - contextReserveTokens

  if (availableTokens <= 0) {
    return messages.length
  }

  const n = messages.length
  const cumTokens: Array<number> = Array.from({ length: n + 1 }, () => 0)

  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + (perMessageTokens[i] ?? 0)
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
    const displayTools = uniqueTools.length > 5 ? [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`] : uniqueTools
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

export function createTruncationSystemContext(removedCount: number, compressedCount: number, summary: string): string {
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

  context += `If you need earlier context, ask the user or check available tools for conversation history access.\n` + `[END CONTEXT]\n\n`

  return context
}

export function createTruncationMarker(removedCount: number, compressedCount: number, summary: string): MessageParam {
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
  // Converge to a fixpoint: processToolBlocks may drop a leading message that
  // ensureAnthropicStartsWithUser just exposed (and vice-versa), so iterate until
  // the message count stabilizes. Both steps only delete (never add) and are
  // idempotent, so length is monotonically decreasing → terminates. (Mirrors the
  // OpenAI cleanupMessages do-while.) The strengthened ensure also drops leading
  // pure-tool_result user turns, so the result is a legal `messages[0]`.
  let result = messages
  let prevLength: number
  do {
    prevLength = result.length
    // NOTE: processToolBlocks here does NOT run rewriteServerToolBlocks (that
    // lives only in sanitizeAnthropicMessages). Auto-truncate always runs on an
    // already-sanitized payload, so any historical server_tool_use has already
    // been downgraded to tool_use upstream — nothing for this pass to rewrite.
    result = processToolBlocks(result, undefined).messages
    result = ensureAnthropicStartsWithUser(result)
  } while (result.length !== prevLength)
  return result
}
