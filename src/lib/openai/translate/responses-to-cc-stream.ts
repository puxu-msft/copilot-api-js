import type { ServerSentEventMessage } from "fetch-event-stream"

import type { ChatCompletionChunk, FinishReason, StreamingDelta } from "~/types/api/openai-chat-completions"
import type { ResponsesResponse, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { mapIncompleteFinishReason } from "./responses-to-cc"

export interface StreamTranslatorState {
  sentFirstChunk: boolean
  responseId: string
  model: string
  toolCallIndexMap: Map<number, number>
  nextToolCallIndex: number
  toolCallIds: Map<number, string>
  includeUsage: boolean
}

export function createStreamTranslator(opts: { includeUsage: boolean }): {
  translate(event: ResponsesStreamEvent): Array<ChatCompletionChunk>
  getState(): StreamTranslatorState
} {
  const state: StreamTranslatorState = {
    sentFirstChunk: false,
    responseId: "",
    model: "",
    toolCallIndexMap: new Map(),
    nextToolCallIndex: 0,
    toolCallIds: new Map(),
    includeUsage: opts.includeUsage,
  }

  function translate(event: ResponsesStreamEvent): Array<ChatCompletionChunk> {
    switch (event.type) {
      case "response.created": {
        state.responseId = event.response.id
        state.model = event.response.model
        state.sentFirstChunk = true
        return [buildChunk(state, { role: "assistant" })]
      }

      case "response.output_text.delta": {
        return [buildChunk(state, { content: event.delta })]
      }

      case "response.refusal.delta": {
        return [buildChunk(state, { content: event.delta })]
      }

      case "response.output_item.added": {
        if (event.item.type !== "function_call") return []

        const toolCallIndex = state.nextToolCallIndex++
        const callId = event.item.call_id || event.item.id
        state.toolCallIndexMap.set(event.output_index, toolCallIndex)
        state.toolCallIds.set(event.output_index, callId)

        return [
          buildChunk(state, {
            tool_calls: [
              {
                index: toolCallIndex,
                id: callId,
                type: "function",
                function: { name: event.item.name },
              },
            ],
          }),
        ]
      }

      case "response.function_call_arguments.delta": {
        const toolCallIndex = state.toolCallIndexMap.get(event.output_index)
        if (toolCallIndex === undefined) return []

        return [
          buildChunk(state, {
            tool_calls: [
              {
                index: toolCallIndex,
                function: { arguments: event.delta },
              },
            ],
          }),
        ]
      }

      case "response.completed": {
        syncStateFromResponse(state, event.response)
        const chunks = [buildChunk(state, {}, state.nextToolCallIndex > 0 ? "tool_calls" : "stop")]
        if (state.includeUsage && event.response.usage) {
          chunks.push(buildUsageChunk(state, event.response))
        }
        return chunks
      }

      case "response.incomplete": {
        syncStateFromResponse(state, event.response)
        return [buildChunk(state, {}, mapIncompleteFinishReason(event.response.incomplete_details))]
      }

      case "response.failed": {
        throw new Error(event.response.error?.message ?? "Upstream response failed")
      }

      case "error": {
        throw new Error(event.message ?? "Upstream error")
      }

      default: {
        return []
      }
    }
  }

  return {
    translate,
    getState: () => state,
  }
}

export async function* translateResponsesStream(
  upstream: AsyncIterable<ServerSentEventMessage>,
  translator: { translate(event: ResponsesStreamEvent): Array<ChatCompletionChunk> },
): AsyncGenerator<ServerSentEventMessage> {
  for await (const rawEvent of upstream) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") continue

    const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
    const chunks = translator.translate(event)

    for (const chunk of chunks) {
      yield { data: JSON.stringify(chunk), event: "message" } as ServerSentEventMessage
    }
  }

  yield { data: "[DONE]" } as ServerSentEventMessage
}

function syncStateFromResponse(state: StreamTranslatorState, response: ResponsesResponse) {
  if (!state.responseId) state.responseId = response.id
  if (!state.model) state.model = response.model
}

function buildChunk(
  state: StreamTranslatorState,
  delta: StreamingDelta,
  finishReason: FinishReason | null = null,
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function buildUsageChunk(state: StreamTranslatorState, response: ResponsesResponse): ChatCompletionChunk {
  const usage = response.usage
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [],
    ...(usage && {
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        ...(usage.input_tokens_details?.cached_tokens !== undefined && {
          prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens },
        }),
        ...(usage.output_tokens_details?.reasoning_tokens !== undefined && {
          completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
        }),
      },
    }),
  }
}
