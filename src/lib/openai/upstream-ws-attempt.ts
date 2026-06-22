/**
 * Upstream WebSocket attempt for the Responses API — the transport-internal
 * "HTTP vs WS" second choice (docs/v4/03-spec/retry-transport.md §4.1).
 *
 * Extracted verbatim from `responses-client.ts` so BOTH the legacy
 * `createResponses` (HTTP-pipeline path) and the v4 `createUpstreamResponsesTransport`
 * (driver path) share one implementation of: pool acquire/reuse, half-open
 * circuit-break fallback, the layered abort wiring (shutdown / client-abort /
 * first-event timeout / idle timeout), and the connection-busy cleanup. Behavior
 * is byte-identical to the pre-extraction code — `openai-responses-client.it.test.ts`
 * exercises `createResponses` and guards the move.
 *
 * The upstream-WS choice is a TRANSPORT-internal detail, transparent to the
 * driver and codec (retry-transport.md §4.1): the caller decides HTTP vs WS from
 * `wire.stream` + model, calls {@link attemptUpstreamResponsesWs}, and on
 * `fallback` degrades to HTTP.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  createFetchSignal,
  getHeaderCaseInsensitive,
} from "~/lib/fetch-utils"
import { isWsResponsesSupported } from "~/lib/models/endpoint"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  combineAbortSignals,
  raceIteratorNext,
  STREAM_ABORTED,
} from "~/lib/stream"

import type { PreparedOpenAIRequest } from "./request-preparation"
import type { UpstreamWsConnection } from "./upstream-ws-connection"

import { getUpstreamWsManager } from "./upstream-ws"

/**
 * Connection-invariant headers that meaningfully change upstream behavior.
 * Differences in these on a reused connection are worth logging.
 * (Excludes per-request tracking IDs like x-request-id / X-Agent-Task-Id.)
 */
const HEADER_REUSE_INVARIANTS = ["openai-intent", "X-Interaction-Type", "X-Initiator", "copilot-vision-request"] as const

/** Whether the upstream WS path is currently usable for `model`. */
export function canUseUpstreamWebSocket(model: Model | undefined): boolean {
  const manager = getUpstreamWsManager()
  return state.upstreamWebSocket && !manager.temporarilyDisabled && !manager.stopped && isWsResponsesSupported(model)
}

export type UpstreamWsAttempt = { kind: "ok"; generator: AsyncGenerator<ServerSentEventMessage> } | { kind: "fallback" }

/** Options governing one upstream-WS attempt (reuse keying + lifecycle aborts). */
export interface UpstreamWsAttemptOptions {
  /** Fallback reuse key when `previous_response_id` is absent (per-conversation WS). */
  conversationId?: string
  /** Client-disconnect signal propagated into the WS request so it frees promptly. */
  clientAbortSignal?: AbortSignal
  /**
   * Stale-request REAPER signal (`ctx.lifecycleSignal`) — a DISTINCT provenance from
   * `clientAbortSignal`, folded into the WS request so a reap cancels the in-flight WS
   * + frees the connection. The OUTER guard (`guardSseIterable` in responses-transport)
   * distinguishes reaper-cancel → `stream-error` → error frame for a live client (缺陷④).
   */
  reaperSignal?: AbortSignal
}

/**
 * Attempt the request over an upstream WebSocket connection. Resolves to `ok`
 * with a frame generator on a successful first event, or `fallback` when the
 * connection can't be acquired or fails before the first event — the caller then
 * degrades to HTTP.
 */
export async function attemptUpstreamResponsesWs(
  prepared: PreparedOpenAIRequest<ResponsesPayload>,
  opts?: UpstreamWsAttemptOptions,
): Promise<UpstreamWsAttempt> {
  const manager = getUpstreamWsManager()
  const { wire } = prepared
  const previousResponseId = typeof wire.previous_response_id === "string" ? wire.previous_response_id : undefined

  const reusable =
    previousResponseId || opts?.conversationId ?
      manager.findReusable({
        previousResponseId,
        conversationId: opts?.conversationId,
        model: wire.model,
      })
    : undefined

  if (reusable) logHeaderReuseDiff(reusable, prepared.headers)

  // Acquire connection inside try/catch so that any failure here (including
  // the `stopNew()`/`create()` TOCTOU window during shutdown) flows through
  // the same fallback path as handshake/first-event failures. Without this,
  // `manager.create()` throwing "not accepting new work" would bubble up to
  // the caller and the request would 500 instead of degrading to HTTP.
  let connection: UpstreamWsConnection
  try {
    connection = reusable ?? (await manager.create({ headers: prepared.headers, model: wire.model, conversationId: opts?.conversationId }))
  } catch (error) {
    manager.recordFallback()
    consola.warn(
      `[responses] Upstream WS acquire failed, falling back to HTTP `
        + `(${manager.consecutiveFallbacks}/3): ${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: "fallback" }
  }

  // requestAbort governs the WS request lifecycle (connect + sendRequest).
  // We layer external signals on top so any of: shutdown, client abort, first-event
  // timeout, or stream idle timeout can cleanly tear down the WS request and free
  // the connection's busy state.
  const requestAbort = new AbortController()
  const shutdownSignal = getShutdownSignal()
  const clientAbortSignal = opts?.clientAbortSignal
  const reaperSignal = opts?.reaperSignal
  const wsRequestSignal = combineAbortSignals(shutdownSignal, clientAbortSignal, reaperSignal, requestAbort.signal)

  // Forward external aborts into the local controller so finally-cleanup is consistent.
  const onExternalAbort = () => requestAbort.abort()
  shutdownSignal.addEventListener("abort", onExternalAbort, { once: true })
  clientAbortSignal?.addEventListener("abort", onExternalAbort, { once: true })
  reaperSignal?.addEventListener("abort", onExternalAbort, { once: true })

  const fetchSignal = createFetchSignal()
  const onFetchTimeout = () => {
    requestAbort.abort(new Error("Upstream WebSocket first-event timeout"))
  }
  fetchSignal?.addEventListener("abort", onFetchTimeout, { once: true })

  const detachExternal = () => {
    shutdownSignal.removeEventListener("abort", onExternalAbort)
    clientAbortSignal?.removeEventListener("abort", onExternalAbort)
    reaperSignal?.removeEventListener("abort", onExternalAbort)
    fetchSignal?.removeEventListener("abort", onFetchTimeout)
  }

  try {
    if (!connection.isOpen) {
      // Handshake honors fetch timeout via the same combined signal.
      await connection.connect({ signal: combineAbortSignals(wsRequestSignal, fetchSignal) })
    }

    const iterator = connection.sendRequest(wire, { abortSignal: wsRequestSignal })[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) {
      throw new Error("Upstream WebSocket closed before first event")
    }

    // First event received — fetch-timeout no longer applies; stream idle timeout
    // takes over for the remaining frames.
    fetchSignal?.removeEventListener("abort", onFetchTimeout)
    manager.recordSuccessfulStart()

    return {
      kind: "ok",
      generator: streamWsEvents({
        firstEvent: first.value,
        iterator,
        requestAbort,
        shutdownSignal,
        clientAbortSignal,
        reaperSignal,
        onComplete: () => {
          shutdownSignal.removeEventListener("abort", onExternalAbort)
          clientAbortSignal?.removeEventListener("abort", onExternalAbort)
          reaperSignal?.removeEventListener("abort", onExternalAbort)
        },
      }),
    }
  } catch (error) {
    detachExternal()
    // Abort the WS request so the connection's busy state is cleared even when
    // the failure originated outside sendRequest (e.g. handshake error).
    requestAbort.abort()
    manager.recordFallback()
    connection.close()
    consola.warn(
      `[responses] Upstream WS failed before first event, falling back to HTTP `
        + `(${manager.consecutiveFallbacks}/3): ${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: "fallback" }
  }
}

interface StreamWsEventsOptions {
  firstEvent: ResponsesStreamEvent
  iterator: AsyncIterator<ResponsesStreamEvent>
  requestAbort: AbortController
  shutdownSignal: AbortSignal | undefined
  clientAbortSignal: AbortSignal | undefined
  reaperSignal: AbortSignal | undefined
  onComplete: () => void
}

async function* streamWsEvents(opts: StreamWsEventsOptions): AsyncGenerator<ServerSentEventMessage> {
  const { firstEvent, iterator, requestAbort, shutdownSignal, clientAbortSignal, reaperSignal, onComplete } = opts
  const idleTimeoutMs = state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0
  const idleAbortSignal = combineAbortSignals(shutdownSignal, clientAbortSignal, reaperSignal)

  try {
    yield toSseMessage(firstEvent)

    for (;;) {
      const result = await raceIteratorNext(iterator.next(), {
        idleTimeoutMs,
        abortSignal: idleAbortSignal,
      })
      // STREAM_ABORTED here returns a CLEAN done on purpose. This generator is
      // never consumed bare — its output is always wrapped by an outer abort
      // guard (`guardSseIterable` in responses/handler.ts & fallback.ts, or the
      // hand-written race loop in responses/ws.ts) that owns shutdown vs. client
      // distinction and throws StreamShutdownError on shutdown. The outer guard
      // observes the shutdown signal first (its abort racer settles ahead of
      // this generator resuming + returning), so this clean return is shadowed
      // and never surfaces as a false "natural completion". Do NOT change this to
      // throw: that would break bare-iteration callers and double-handle shutdown.
      if (result === STREAM_ABORTED) return
      if (result.done) return
      yield toSseMessage(result.value)
    }
  } finally {
    // Cover three exit paths uniformly: normal completion, consumer early-return,
    // and exceptions (idle timeout, parse error, etc.). Each must free the
    // connection's busy state and detach external listeners.
    requestAbort.abort()
    onComplete()
    if (typeof iterator.return === "function") {
      try {
        await iterator.return(undefined)
      } catch {
        // Connection-side iterator.return is best-effort.
      }
    }
  }
}

function logHeaderReuseDiff(connection: UpstreamWsConnection, newHeaders: Record<string, string>): void {
  const previous = connection.handshakeHeaders

  const diffs: Array<string> = []
  for (const invariant of HEADER_REUSE_INVARIANTS) {
    const oldValue = getHeaderCaseInsensitive(previous, invariant)
    const newValue = getHeaderCaseInsensitive(newHeaders, invariant)
    if (oldValue !== newValue) {
      diffs.push(`${invariant}: ${oldValue ?? "<unset>"} → ${newValue ?? "<unset>"}`)
    }
  }

  if (diffs.length > 0) {
    consola.debug(`[upstream-ws] Reusing connection with header drift: ${diffs.join(", ")}`)
  }
}

function toSseMessage(event: ResponsesStreamEvent): ServerSentEventMessage {
  return {
    event: event.type,
    data: JSON.stringify(event),
  }
}
