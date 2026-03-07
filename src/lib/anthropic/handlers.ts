/**
 * Anthropic API routing and stream processing utilities.
 *
 * Reusable components shared across route handlers and tests:
 * - API routing decisions (vendor/endpoint validation)
 * - SSE stream processing (parse, accumulate, shutdown-aware iteration)
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { StreamEvent } from "~/types/api/anthropic"

import { ENDPOINT, isEndpointSupported } from "~/lib/models/endpoint"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals, raceIteratorNext, STREAM_ABORTED } from "~/lib/stream"

import { type AnthropicStreamAccumulator, accumulateAnthropicStreamEvent } from "./stream-accumulator"

// ============================================================================
// API routing
// ============================================================================

export interface ApiRoutingDecision {
  supported: boolean
  reason: string
}

/**
 * Check if a model supports direct Anthropic API.
 * Returns a decision with reason so callers can log/display the routing rationale.
 */
export function supportsDirectAnthropicApi(modelId: string): ApiRoutingDecision {
  const model = state.modelIndex.get(modelId)
  if (model?.vendor !== "Anthropic") {
    return { supported: false, reason: `vendor is "${model?.vendor ?? "unknown"}", not Anthropic` }
  }

  if (!isEndpointSupported(model, ENDPOINT.MESSAGES)) {
    return { supported: false, reason: "model does not support /v1/messages endpoint" }
  }

  return { supported: true, reason: "Anthropic vendor with /v1/messages support" }
}

// ============================================================================
// Stream processing
// ============================================================================

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
 *
 * Each iteration races `iterator.next()` against idle timeout (if configured)
 * and the shutdown abort signal — so a stalled upstream connection can be
 * interrupted by either mechanism without waiting for the next event.
 */
export async function* processAnthropicStream(
  response: AsyncIterable<ServerSentEventMessage>,
  acc: AnthropicStreamAccumulator,
  clientAbortSignal?: AbortSignal,
): AsyncGenerator<ProcessedAnthropicEvent> {
  const idleTimeoutMs = state.streamIdleTimeout * 1000
  const iterator = response[Symbol.asyncIterator]()
  const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbortSignal)

  for (;;) {
    const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal })

    // Shutdown abort signal fired while waiting for the next event
    if (result === STREAM_ABORTED) break

    if (result.done) break

    const rawEvent = result.value

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

    // Error event is terminal — Anthropic sends no more events after this
    if (parsed?.type === "error") break
  }
}

// ============================================================================
// Re-exports
// ============================================================================

// Stream accumulator — re-exported for convenience

export { type AnthropicStreamAccumulator, createAnthropicStreamAccumulator } from "./stream-accumulator"
