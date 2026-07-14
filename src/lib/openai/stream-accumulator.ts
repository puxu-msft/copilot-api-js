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
  /**
   * Accumulated PLAINTEXT reasoning (GHC `delta.reasoning` / `reasoning_content`). Forwarded as a
   * synthetic `thinking` block on the Anthropic translation leg (richest-data-flow) — see
   * `~/lib/anthropic/synthetic-reasoning`. Empty when the upstream emits no plaintext reasoning.
   */
  reasoningText: string
  /** GHC input-side modality breakdown (blob-only; last usage frame wins). */
  inputDetails?: InputDetails
  /** GHC output-side modality + prediction breakdown (blob-only). */
  outputDetails?: OutputDetails
  finishReason: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  toolCallMap: Map<number, ToolCallAccumulator>
  /**
   * A TERMINAL upstream `error` frame (`{"error":{"message":...,"type":...}}`), if one was
   * seen. Symmetric with the Anthropic/Responses accumulators' `streamError`: an in-band
   * `error` frame is an upstream DECISION to fail (overload / server error), delivered as a
   * clean SSE frame that drains without ever setting `finishReason`. The block-level buffered
   * path (P3 — `ccCommitBoundaries`) treats such a frame as a commit boundary; this field lets
   * the handler's `sawUpstreamError` COMMIT + fail it (the real code/message) instead of
   * wastefully retrying it as a transport truncation. Undefined = no terminal error frame seen.
   */
  streamError?: { message: string; type: string }
}

export function createOpenAIStreamAccumulator(): OpenAIStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reasoningText: "",
    finishReason: "",
    rawContent: "",
    toolCalls: [],
    toolCallMap: new Map(),
  }
}

/** Accumulate a single parsed OpenAI chunk into the accumulator */
export function accumulateOpenAIStreamEvent(parsed: ChatCompletionChunk, acc: OpenAIStreamAccumulator) {
  if (parsed.model && !acc.model) acc.model = parsed.model

  // A TERMINAL upstream `error` frame (not part of the SDK's `ChatCompletionChunk` shape — GHC
  // emits it in-band instead of a lifecycle chunk) — see `ccCommitBoundaries` / `streamError` doc.
  const errorField = (parsed as unknown as { error?: { message?: string; type?: string } }).error
  if (errorField) {
    acc.streamError = { message: errorField.message ?? "Unknown stream error", type: errorField.type ?? "server_error" }
    return
  }

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
    // Plaintext reasoning (GHC extension `delta.reasoning` / `reasoning_content`) — capture it so the
    // Anthropic translation leg can forward it as a synthetic thinking block (richest-data-flow).
    const rd = choice.delta as { reasoning?: unknown; reasoning_content?: unknown }
    if (typeof rd.reasoning === "string") acc.reasoningText += rd.reasoning
    else if (typeof rd.reasoning_content === "string") acc.reasoningText += rd.reasoning_content
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
