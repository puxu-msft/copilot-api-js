/**
 * Stream accumulator for OpenAI format responses.
 * Handles accumulating ChatCompletionChunk events for history recording and tracking.
 */

import type { BaseStreamAccumulator } from "~/lib/stream"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"
import type { GhcCompletionTokensDetails, GhcPromptTokensDetails } from "~/types/api/ghc-usage"

import { nonNegOrUndef } from "~/types/api/ghc-usage"

/** Internal tool call accumulator using string array to avoid O(n²) concatenation */
interface ToolCallAccumulator {
  id: string
  name: string
  argumentParts: Array<string>
}

/** GHC modality/prediction detail bags carried alongside the scalar token counts. */
type InputDetails = { text?: number; audio?: number; image?: number; video?: number }
type OutputDetails = { text?: number; audio?: number; image?: number; video?: number; accepted_prediction_tokens?: number; rejected_prediction_tokens?: number }

/** Stream accumulator for OpenAI format */
export interface OpenAIStreamAccumulator extends BaseStreamAccumulator {
  cachedTokens: number
  /** GHC cache_write_tokens from prompt_tokens_details (subset of prompt_tokens). */
  cacheWriteTokens: number
  reasoningTokens: number
  /** GHC input-side modality breakdown (blob-only; last usage frame wins). */
  inputDetails?: InputDetails
  /** GHC output-side modality + prediction breakdown (blob-only). */
  outputDetails?: OutputDetails
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
    cacheWriteTokens: 0,
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
    const pd = parsed.usage.prompt_tokens_details as GhcPromptTokensDetails | undefined
    if (pd?.cached_tokens !== undefined && pd.cached_tokens !== null) {
      acc.cachedTokens = pd.cached_tokens
    }
    const cw = nonNegOrUndef(pd?.cache_write_tokens)
    if (cw !== undefined) acc.cacheWriteTokens = cw
    acc.inputDetails = { text: nonNegOrUndef(pd?.text_tokens), audio: nonNegOrUndef(pd?.audio_tokens), image: nonNegOrUndef(pd?.image_tokens), video: nonNegOrUndef(pd?.video_tokens) }
    const cd = parsed.usage.completion_tokens_details as GhcCompletionTokensDetails | undefined
    if (cd?.reasoning_tokens !== undefined && cd.reasoning_tokens !== null) {
      acc.reasoningTokens = cd.reasoning_tokens
    }
    acc.outputDetails = {
      text: nonNegOrUndef(cd?.text_tokens),
      audio: nonNegOrUndef(cd?.audio_tokens),
      image: nonNegOrUndef(cd?.image_tokens),
      video: nonNegOrUndef(cd?.video_tokens),
      accepted_prediction_tokens: nonNegOrUndef(cd?.accepted_prediction_tokens),
      rejected_prediction_tokens: nonNegOrUndef(cd?.rejected_prediction_tokens),
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
