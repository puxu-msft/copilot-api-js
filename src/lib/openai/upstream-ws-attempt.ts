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
import type { UpstreamDispatchLifecycle } from "~/lib/pipeline/types"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  createResponseHeaderTimeoutSignal,
  getHeaderCaseInsensitive,
} from "~/lib/fetch-utils"
import { isWsResponsesSupported } from "~/lib/models/endpoint"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
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

/** Whether the upstream WS path is currently usable for `model`. `modelKey` is
 * the bare outbound model string (same key space as the connection pool + the
 * breaker) — the per-model circuit breaker is queried on it. */
export function canUseUpstreamWebSocket(model: Model | undefined, modelKey: string): boolean {
  const manager = getUpstreamWsManager()
  return state.upstreamWebSocket && !manager.temporarilyDisabled(modelKey) && !manager.stopped && isWsResponsesSupported(model)
}

export type UpstreamWsAttempt =
  | { kind: "ok"; generator: AsyncGenerator<ServerSentEventMessage>; lifecycle: UpstreamDispatchLifecycle }
  | { kind: "fallback"; error: unknown }

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
  /** Candidate/dispatch-local cancellation, independent from request-level signals. */
  dispatchSignal?: AbortSignal
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
  if (opts?.dispatchSignal?.aborted) {
    throw opts.dispatchSignal.reason instanceof Error ? opts.dispatchSignal.reason : new DOMException("The operation was aborted.", "AbortError")
  }
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
    manager.recordFallback(wire.model)
    consola.warn(
      `[responses] Upstream WS acquire failed, falling back to HTTP `
        + `(${manager.consecutiveFallbacks(wire.model)}/3): ${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: "fallback", error }
  }

  // requestAbort governs the WS request lifecycle (connect + sendRequest).
  // We layer external signals on top so any of: shutdown, client abort, first-event
  // timeout, or stream idle timeout can cleanly tear down the WS request and free
  // the connection's busy state.
  const requestAbort = new AbortController()
  const shutdownSignal = getShutdownSignal()
  const clientAbortSignal = opts?.clientAbortSignal
  const reaperSignal = opts?.reaperSignal
  const dispatchSignal = opts?.dispatchSignal
  const wsRequestSignal = combineAbortSignals(shutdownSignal, clientAbortSignal, reaperSignal, dispatchSignal, requestAbort.signal)

  // Forward external aborts into the local controller. Once the lifecycle handle exists,
  // the same callback also owns connection disposal so quiescence cannot depend on a consumer
  // ever starting the prefetched-frame generator.
  let disposeAfterHandle: ((reason: string) => void) | undefined
  const onExternalAbort = () => {
    requestAbort.abort()
    disposeAfterHandle?.("Request aborted")
  }
  shutdownSignal.addEventListener("abort", onExternalAbort, { once: true })
  clientAbortSignal?.addEventListener("abort", onExternalAbort, { once: true })
  reaperSignal?.addEventListener("abort", onExternalAbort, { once: true })
  dispatchSignal?.addEventListener("abort", onExternalAbort, { once: true })

  const fetchSignal = createResponseHeaderTimeoutSignal(wire.model)
  const onFetchTimeout = () => {
    requestAbort.abort(new Error("Upstream WebSocket first-event timeout"))
  }
  fetchSignal?.addEventListener("abort", onFetchTimeout, { once: true })

  const detachExternal = () => {
    shutdownSignal.removeEventListener("abort", onExternalAbort)
    clientAbortSignal?.removeEventListener("abort", onExternalAbort)
    reaperSignal?.removeEventListener("abort", onExternalAbort)
    dispatchSignal?.removeEventListener("abort", onExternalAbort)
    fetchSignal?.removeEventListener("abort", onFetchTimeout)
  }

  try {
    if (!connection.isOpen) {
      // Handshake honors fetch timeout via the same combined signal.
      await connection.connect({ signal: combineAbortSignals(wsRequestSignal, fetchSignal) })
    }

    // Admission may have succeeded just before cancellation. Re-check at the last possible
    // point before `sendRequest()` puts response.create on the physical wire.
    if (wsRequestSignal?.aborted) {
      throw wsRequestSignal.reason instanceof Error ? wsRequestSignal.reason : new DOMException("The operation was aborted.", "AbortError")
    }

    const iterator = connection.sendRequest(wire, { abortSignal: wsRequestSignal })[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) {
      throw new Error("Upstream WebSocket closed before first event")
    }

    // First event received — fetch-timeout no longer applies; stream idle timeout
    // takes over for the remaining frames.
    fetchSignal?.removeEventListener("abort", onFetchTimeout)
    manager.recordSuccessfulStart(wire.model)

    let resolveQuiesced!: () => void
    let rejectQuiesced!: (error: unknown) => void
    const quiesced = new Promise<void>((resolve, reject) => {
      resolveQuiesced = resolve
      rejectQuiesced = reject
    })
    let disposal: Promise<void> | undefined
    let iteratorCleanup: Promise<void> | undefined
    let disposing = false
    const ensureIteratorCleanup = (): Promise<void> => {
      iteratorCleanup ??= (async () => {
        if (typeof iterator.return !== "function") return
        try {
          await iterator.return(undefined)
        } catch {
          // Connection disposal owns the terminal result; iterator cleanup is best-effort,
          // but the quiescence barrier is later than this cleanup attempt.
        }
      })()
      return iteratorCleanup
    }
    const ensureDisposal = (reason?: string): Promise<void> => {
      if (disposal) return disposal
      disposing = true
      // Disposal is the ownership barrier. Detach every external callback before the
      // connection closes so quiesced never resolves with a live abort listener.
      detachExternal()
      if (!requestAbort.signal.aborted) requestAbort.abort(new DOMException(reason ?? "The operation was aborted.", "AbortError"))
      disposal = Promise.all([connection.dispose(reason ?? "Dispatch disposed"), ensureIteratorCleanup()]).then(
        () => resolveQuiesced(),
        (error: unknown) => {
          rejectQuiesced(error)
          throw error
        },
      )
      // `cancel()` is synchronous; observe a disposal rejection until an owner awaits the barrier.
      void disposal.catch(() => {})
      return disposal
    }
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel(reason) {
        void ensureDisposal(reason)
      },
      async dispose(reason) {
        await ensureDisposal(reason)
        await quiesced
        return { quiesced: true, connectionReusable: false }
      },
      quiesced,
    }
    disposeAfterHandle = (reason) => {
      void ensureDisposal(reason)
    }
    if (shutdownSignal.aborted || clientAbortSignal?.aborted || reaperSignal?.aborted || dispatchSignal?.aborted) disposeAfterHandle("Request aborted")

    return {
      kind: "ok",
      lifecycle,
      generator: streamWsEvents({
        firstEvent: first.value,
        iterator,
        ensureIteratorCleanup,
        requestAbort,
        isCancelled: () => requestAbort.signal.aborted,
        shutdownSignal,
        clientAbortSignal,
        reaperSignal,
        idleTimeoutMs: resolveStreamIdleTimeoutMs(wire.model),
        onComplete: async (naturalCompletion) => {
          shutdownSignal.removeEventListener("abort", onExternalAbort)
          clientAbortSignal?.removeEventListener("abort", onExternalAbort)
          reaperSignal?.removeEventListener("abort", onExternalAbort)
          dispatchSignal?.removeEventListener("abort", onExternalAbort)
          if (naturalCompletion && !disposing) resolveQuiesced()
          else await ensureDisposal("WS response consumer stopped before natural completion")
        },
      }),
    }
  } catch (error) {
    detachExternal()
    // Abort the WS request so the connection's busy state is cleared even when
    // the failure originated outside sendRequest (e.g. handshake error).
    requestAbort.abort()
    await connection.dispose("Before-first-event fallback")
    const cancelled = shutdownSignal.aborted || clientAbortSignal?.aborted || reaperSignal?.aborted || dispatchSignal?.aborted
    if (cancelled) return { kind: "fallback", error }
    manager.recordFallback(wire.model)
    consola.warn(
      `[responses] Upstream WS failed before first event, falling back to HTTP `
        + `(${manager.consecutiveFallbacks(wire.model)}/3): ${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: "fallback", error }
  }
}

interface StreamWsEventsOptions {
  firstEvent: ResponsesStreamEvent
  iterator: AsyncIterator<ResponsesStreamEvent>
  ensureIteratorCleanup: () => Promise<void>
  requestAbort: AbortController
  isCancelled: () => boolean
  shutdownSignal: AbortSignal | undefined
  clientAbortSignal: AbortSignal | undefined
  reaperSignal: AbortSignal | undefined
  /** Per-model frame-idle timeout (ms; 0 = disabled), resolved by the caller (INV-2 — this deep fn never sees the model). */
  idleTimeoutMs: number
  onComplete: (naturalCompletion: boolean) => Promise<void>
}

async function* streamWsEvents(opts: StreamWsEventsOptions): AsyncGenerator<ServerSentEventMessage> {
  const { firstEvent, iterator, ensureIteratorCleanup, requestAbort, isCancelled, shutdownSignal, clientAbortSignal, reaperSignal, idleTimeoutMs, onComplete } =
    opts
  const idleAbortSignal = combineAbortSignals(shutdownSignal, clientAbortSignal, reaperSignal)
  let naturalCompletion = false

  try {
    // The first frame was prefetched before the lifecycle handle escaped. A loser may be
    // cancelled before its consumer starts; never leak that cached frame after the barrier.
    if (isCancelled()) return
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
      if (result.done) {
        naturalCompletion = true
        return
      }
      yield toSseMessage(result.value)
    }
  } finally {
    // Cover three exit paths uniformly: normal completion, consumer early-return,
    // and exceptions (idle timeout, parse error, etc.). Each must free the
    // connection's busy state and detach external listeners.
    if (!naturalCompletion) requestAbort.abort()
    await ensureIteratorCleanup()
    // Quiescence is later than iterator cleanup. History may seal after this callback.
    await onComplete(naturalCompletion)
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
