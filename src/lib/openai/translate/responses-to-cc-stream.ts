import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type {
  //
  ChatCompletionChunk,
  FinishReason,
  StreamingDelta,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  mapIncompleteFinishReason,
  mapResponsesUsageToCC,
} from "./responses-to-cc"

export interface StreamTranslatorState {
  sentFirstChunk: boolean
  responseId: string
  model: string
  toolCallIndexMap: Map<number, number>
  nextToolCallIndex: number
  toolCallIds: Map<number, string>
}

export function createStreamTranslator(): {
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
        // Reasoning item — carries GHC's opaque `encrypted_content` (present before the summary deltas).
        // Emit it on the proxy CC-intermediate `delta.reasoning_encrypted_content` so the downstream
        // Anthropic renderer can embed it in the synthetic thinking block's labeled-envelope signature
        // (cross-turn round-trip). No summary TEXT here — that streams via reasoning_summary_text.delta.
        if (event.item.type === "reasoning") {
          const enc = event.item.encrypted_content
          return typeof enc === "string" && enc.length > 0 ? [buildReasoningChunk(state, { encrypted: enc })] : []
        }
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

      // Reasoning summary (thinking) text — GHC's DISPLAYABLE reasoning, streamed as plaintext deltas
      // when the request asked for `reasoning.summary` AND the effort produced one (low effort emits
      // none — verified probe exp/synthetic-reasoning-summary-shape). Forward each delta on the proxy
      // CC-intermediate `delta.reasoning`; the downstream Anthropic renderer opens a synthetic thinking
      // block. Absence is graceful (no reasoning chunk → no thinking block).
      case "response.reasoning_summary_text.delta": {
        return event.delta ? [buildReasoningChunk(state, { reasoning: event.delta })] : []
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
        // Always emit the usage chunk when the upstream carries usage — consistent
        // with the direct-CC path (which unconditionally forwards GHC's usage chunk)
        // and required so history/telemetry capture usage even when the client did
        // not set stream_options.include_usage. Previously gated on `includeUsage`,
        // which silently zeroed usage for CC→Responses streaming. See spec.
        if (event.response.usage) {
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
        throw new Error(event.message)
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

    // Tolerate occasional malformed frames from upstream (SSE parsers may
    // surface non-JSON payloads on comment lines, partial chunks, or heartbeats).
    // Mirrors the defensive `try/catch` in `routes/responses/handler.ts` around
    // the same upstream — without this, a single SyntaxError tears down the
    // entire chat-completions stream and surfaces as `server_error` to the client.
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
    } catch (err) {
      consola.debug(`[cc←responses] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, rawEvent.data.slice(0, 200))
      continue
    }

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

function buildChunk(state: StreamTranslatorState, delta: StreamingDelta, finishReason: FinishReason | null = null): ChatCompletionChunk {
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

/**
 * Build a CC chunk carrying the proxy reasoning-passthrough extension fields (`delta.reasoning` /
 * `delta.reasoning_encrypted_content`). These are GHC/proxy extensions absent from the SDK `Delta` type,
 * so the object is cast — mirrors how the accumulator + the Anthropic renderer read them via cast.
 */
function buildReasoningChunk(state: StreamTranslatorState, fields: { reasoning?: string; encrypted?: string }): ChatCompletionChunk {
  const delta = {
    ...(fields.reasoning !== undefined && { reasoning: fields.reasoning }),
    ...(fields.encrypted !== undefined && { reasoning_encrypted_content: fields.encrypted }),
  } as StreamingDelta
  return buildChunk(state, delta)
}

function buildUsageChunk(state: StreamTranslatorState, response: ResponsesResponse): ChatCompletionChunk {
  const usage = response.usage
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [],
    ...(usage && { usage: mapResponsesUsageToCC(usage) }),
  }
}
