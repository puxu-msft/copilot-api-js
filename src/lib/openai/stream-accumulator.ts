/**
 * Stream accumulator for OpenAI format responses.
 * Handles accumulating ChatCompletionChunk events for history recording and tracking.
 */

import type { BaseStreamAccumulator } from "~/lib/stream"
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
