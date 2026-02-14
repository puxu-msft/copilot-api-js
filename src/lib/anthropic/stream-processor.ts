/**
 * Direct Anthropic stream processing.
 * Parses SSE events, accumulates for history/tracking, checks shutdown signals.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { StreamEvent } from "~/types/api/anthropic"

import { getShutdownSignal } from "~/lib/shutdown"

import { type AnthropicStreamAccumulator, accumulateAnthropicStreamEvent } from "./stream-accumulator"

/** Processed event from the Anthropic stream */
export interface ProcessedAnthropicEvent {
  /** Original SSE message for forwarding */
  raw: ServerSentEventMessage
  /** Parsed event for accumulation (undefined for keepalives / [DONE]) */
  parsed?: StreamEvent
}

/**
 * Process raw Anthropic SSE stream: parse events, accumulate, check shutdown.
 * Yields each event for the caller to forward to the client.
 */
export async function* processAnthropicStream(
  response: AsyncIterable<ServerSentEventMessage>,
  acc: AnthropicStreamAccumulator,
): AsyncGenerator<ProcessedAnthropicEvent> {
  for await (const rawEvent of response) {
    // Check shutdown abort signal — break out of stream gracefully
    if (getShutdownSignal()?.aborted) break

    // No data — keepalive, nothing to accumulate
    if (!rawEvent.data) {
      consola.debug("SSE event with no data (keepalive):", rawEvent.event ?? "(no event type)")
      yield { raw: rawEvent }
      continue
    }

    // [DONE] is not part of the SSE spec - it's an OpenAI convention.
    // Copilot's gateway injects it at the end of all streams, including Anthropic.
    // see refs/vscode-copilot-chat/src/platform/endpoint/node/messagesApi.ts:326
    if (rawEvent.data === "[DONE]") break

    // Try to parse and accumulate for history/tracking
    let parsed: StreamEvent | undefined
    try {
      parsed = JSON.parse(rawEvent.data) as StreamEvent
      accumulateAnthropicStreamEvent(parsed, acc)
    } catch (parseError) {
      consola.error("Failed to parse Anthropic stream event:", parseError, rawEvent.data)
    }

    yield { raw: rawEvent, parsed }
  }
}
