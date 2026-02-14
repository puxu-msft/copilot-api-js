import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { StreamEvent, RawMessageStartEvent } from "~/types/api/anthropic"

import { type AnthropicStreamAccumulator, accumulateAnthropicStreamEvent } from "~/lib/anthropic/stream-accumulator"
import { type ChatCompletionChunk } from "~/lib/openai/client"
import { getShutdownSignal } from "~/lib/shutdown"

import { mapOpenAIStopReasonToAnthropic } from "./non-stream"

export interface StreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  toolCalls: Record<number, { id: string; name: string; anthropicBlockIndex: number }>
  model?: string
}

import { type ToolNameMapping } from "./non-stream"

function isToolBlockOpen(state: StreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some((tc) => tc.anthropicBlockIndex === state.contentBlockIndex)
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: StreamState,
  toolNameMapping?: ToolNameMapping,
): Array<StreamEvent> {
  const events: Array<StreamEvent> = []

  // Skip chunks with empty choices (e.g., first chunk with prompt_filter_results)
  if (chunk.choices.length === 0) {
    // Store model for later if available (some chunks have model but empty choices)
    if (chunk.model && !state.model) {
      state.model = chunk.model
    }
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    // Use model from current chunk, or from stored state (from earlier empty chunk)
    const model = chunk.model || state.model || "unknown"
    // Cast: synthetic message_start — we construct a partial Message object
    // (model is string, usage is partial) that gets JSON-serialized for SSE
    events.push({
      type: "message_start",
      message: {
        id: chunk.id || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    } as unknown as RawMessageStartEvent)
    state.messageStartSent = true
  }

  if (delta.content) {
    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      // Cast: synthetic TextBlock — citations field omitted for translated streams
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      } as StreamEvent)
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        // Restore original tool name if it was truncated
        const originalName = toolNameMapping?.truncatedToOriginal.get(toolCall.function.name) ?? toolCall.function.name

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: originalName,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: originalName,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    // Cast: synthetic message_delta — partial Usage for translated streams
    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      } as StreamEvent,
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): StreamEvent {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}

/** SSE writer interface — decoupled from Hono's SSEStreamingApi */
export interface SSEWriter {
  writeSSE: (msg: { event: string; data: string }) => Promise<void>
}

/** Send truncation marker as Anthropic SSE events */
export async function sendTruncationMarkerEvents(
  stream: SSEWriter,
  streamState: StreamState,
  marker: string,
  model: string,
) {
  // Must send message_start before any content blocks
  if (!streamState.messageStartSent) {
    // Set flag before await to satisfy require-atomic-updates lint rule
    streamState.messageStartSent = true
    const messageStartEvent = {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    }
    await stream.writeSSE({
      event: "message_start",
      data: JSON.stringify(messageStartEvent),
    })
  }

  // Start a new content block for the marker
  const blockStartEvent = {
    type: "content_block_start",
    index: streamState.contentBlockIndex,
    content_block: { type: "text", text: "" },
  }
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify(blockStartEvent),
  })

  // Send the marker text as a delta
  const deltaEvent = {
    type: "content_block_delta",
    index: streamState.contentBlockIndex,
    delta: { type: "text_delta", text: marker },
  }
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify(deltaEvent),
  })

  // Stop the content block
  const blockStopEvent = {
    type: "content_block_stop",
    index: streamState.contentBlockIndex,
  }
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify(blockStopEvent),
  })

  streamState.contentBlockIndex++
}

/**
 * Process OpenAI SSE stream: parse chunks, translate to Anthropic events, accumulate.
 * Yields each translated event for the caller to forward to the client.
 */
export async function* processTranslatedStream(
  response: AsyncIterable<ServerSentEventMessage>,
  streamState: StreamState,
  toolNameMapping: ToolNameMapping | undefined,
  acc: AnthropicStreamAccumulator,
): AsyncGenerator<StreamEvent> {
  for await (const rawEvent of response) {
    // Check shutdown abort signal — break out of stream gracefully
    if (getShutdownSignal()?.aborted) break

    if (!rawEvent.data) {
      consola.debug("SSE event with no data (keepalive):", rawEvent.event ?? "(no event type)")
      continue
    }
    // [DONE] is not part of the SSE spec — it's an OpenAI convention.
    // Copilot's gateway injects it at the end of all streams, including Anthropic.
    if (rawEvent.data === "[DONE]") break

    let chunk: ChatCompletionChunk
    try {
      chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    } catch (parseError) {
      consola.error("Failed to parse stream chunk:", parseError, rawEvent.data)
      continue
    }

    if (chunk.model && !acc.model) acc.model = chunk.model

    const events = translateChunkToAnthropicEvents(chunk, streamState, toolNameMapping)

    for (const event of events) {
      accumulateAnthropicStreamEvent(event, acc)
      yield event
    }
  }
}
