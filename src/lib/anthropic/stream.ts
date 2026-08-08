/**
 * Anthropic SSE stream processing.
 *
 * Reusable components shared across route handlers and tests:
 * - SSE stream processing (parse, accumulate, shutdown-aware iteration)
 *
 * (API routing decisions moved to ./features — `supportsDirectAnthropicApi`.)
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { StreamEvent } from "~/types/api/anthropic"

import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import {
  //
  raceIteratorNext,
  STREAM_ABORTED,
  StreamClientAbortError,
} from "~/lib/stream"

import {
  //
  type AnthropicStreamAccumulator,
  accumulateAnthropicStreamEvent,
} from "./stream-accumulator"

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
 * Process raw Anthropic SSE stream: parse events, accumulate, and race each
 * `iterator.next()` against the idle timeout and downstream client signal. A
 * client disconnect throws `StreamClientAbortError` so the caller records an
 * aborted request instead of a successful truncated stream.
 */
export async function* processAnthropicStream(
  response: AsyncIterable<ServerSentEventMessage>,
  acc: AnthropicStreamAccumulator,
  clientAbortSignal?: AbortSignal,
  idleTimeoutMs: number = resolveStreamIdleTimeoutMs(undefined),
): AsyncGenerator<ProcessedAnthropicEvent> {
  const iterator = response[Symbol.asyncIterator]()

  // Forward shutdown + client signals into one local controller with explicit
  // listener cleanup in `finally` — exactly one listener on the long-lived
  // shutdown signal per stream, removed deterministically (no AbortSignal.any/GC).
  const local = new AbortController()
  const onAbort = () => local.abort()
  clientAbortSignal?.addEventListener("abort", onAbort, { once: true })
  if (clientAbortSignal?.aborted) local.abort()

  try {
    for (;;) {
      const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal: local.signal })

      // An abort fired while waiting for the next event. Query the original
      // signals to learn the source — they have opposite semantics. Check
      // SHUTDOWN FIRST: shutdown is a process-level event that should surface
      // as a retryable error even if the client also disconnected in the same
      // tick (otherwise a shutdown gets misrecorded as a client abort and the
      // client loses its retry cue). Client gone (and not shutting down) →
      // throw StreamClientAbortError so the consumer settles it as `aborted`.
      if (result === STREAM_ABORTED) {
        if (clientAbortSignal?.aborted) throw new StreamClientAbortError()
        return
      }

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
  } finally {
    clientAbortSignal?.removeEventListener("abort", onAbort)
    // Best-effort close of the upstream iterator. Fire-and-forget, NOT awaited:
    // on the abort/throw paths a stalled `iterator.next()` is still pending, and
    // `return()` on a generator suspended mid-`await` queues behind that next() —
    // awaiting here would hang the handler. Unawaited, the queued return() runs
    // its cleanup once the upstream settles (or is aborted at Phase 4 shutdown).
    // On the natural-done / break paths there is no pending next(), so it closes
    // promptly. Without this, the non-natural paths leak the upstream connection.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {
        // Upstream already torn down — nothing to recover.
      })
  }
}

// ============================================================================
// Re-exports
// ============================================================================

// Stream accumulator — re-exported for convenience

export { type AnthropicStreamAccumulator, createAnthropicStreamAccumulator } from "./stream-accumulator"
