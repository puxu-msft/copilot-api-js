/**
 * Stream accumulator for OpenAI format responses.
 * Handles accumulating ChatCompletionChunk events for history recording and tracking.
 */

import type { BaseStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

/** Internal tool call accumulator using string array to avoid O(n²) concatenation */
interface ToolCallAccumulator {
  id: string
  name: string
  argumentParts: Array<string>
}

/** Stream accumulator for OpenAI format */
export interface OpenAIStreamAccumulator extends BaseStreamAccumulator {
  cachedTokens: number
  reasoningTokens: number
  finishReason: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  toolCallMap: Map<number, ToolCallAccumulator>
}

export function createOpenAIStreamAccumulator(): OpenAIStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    finishReason: "",
    rawContent: "",
    toolCalls: [],
    toolCallMap: new Map(),
  }
}

/** Accumulate a single parsed OpenAI chunk into the accumulator */
export function accumulateOpenAIStreamEvent(parsed: ChatCompletionChunk, acc: OpenAIStreamAccumulator) {
  if (parsed.model && !acc.model) acc.model = parsed.model

  if (parsed.usage) {
    acc.inputTokens = parsed.usage.prompt_tokens
    acc.outputTokens = parsed.usage.completion_tokens
    if (parsed.usage.prompt_tokens_details?.cached_tokens !== undefined) {
      acc.cachedTokens = parsed.usage.prompt_tokens_details.cached_tokens
    }
    if (parsed.usage.completion_tokens_details?.reasoning_tokens !== undefined) {
      acc.reasoningTokens = parsed.usage.completion_tokens_details.reasoning_tokens
    }
  }

  const choice = parsed.choices[0] as (typeof parsed.choices)[0] | undefined
  if (choice) {
    if (choice.delta.content) acc.rawContent += choice.delta.content
    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index
        if (!acc.toolCallMap.has(idx)) {
          acc.toolCallMap.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            argumentParts: [],
          })
        }
        const item = acc.toolCallMap.get(idx)
        if (item) {
          if (tc.id) item.id = tc.id
          if (tc.function?.name) item.name = tc.function.name
          if (tc.function?.arguments) item.argumentParts.push(tc.function.arguments)
        }
      }
    }
    if (choice.finish_reason) acc.finishReason = choice.finish_reason
  }
}
