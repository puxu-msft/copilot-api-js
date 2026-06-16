/**
 * Responses API client for Copilot /responses endpoint.
 * Follows the same pattern as chat-completions-client.ts but targets the /responses endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { HeadersCapture } from "~/lib/context/request"
import type { RequestTransport } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  createFetchSignal,
  getHeaderCaseInsensitive,
  sanitizeHeadersForHistory,
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
import { sendUpstreamHttp } from "~/lib/transport/send"

import type { UpstreamWsConnection } from "./upstream-ws-connection"

import {
  //
  prepareResponsesRequest,
  type PreparedOpenAIRequest,
} from "./request-preparation"
import { getUpstreamWsManager } from "./upstream-ws"

interface CreateResponsesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ResponsesPayload>) => void
  onTransport?: (transport: RequestTransport) => void
  /**
   * Optional conversation identifier (e.g. from X-Conversation-Id header).
   * Used as a fallback upstream-WS reuse key when `previous_response_id` is
   * absent. Mirrors GHC per-conversation WS pattern (#4827).
   */
  conversationId?: string
  /**
   * Caller-supplied abort signal (e.g. client disconnect). Propagated into
   * the upstream WS request so the connection is freed promptly when the
   * client goes away.
   */
  clientAbortSignal?: AbortSignal
}

/**
 * Connection-invariant headers that meaningfully change upstream behavior.
 * Differences in these on a reused connection are worth logging.
 * (Excludes per-request tracking IDs like x-request-id / X-Agent-Task-Id.)
 */
const HEADER_REUSE_INVARIANTS = ["openai-intent", "X-Interaction-Type", "X-Initiator", "copilot-vision-request"] as const

export { type PreparedOpenAIRequest, prepareResponsesRequest } from "./request-preparation"

/** Call Copilot /responses endpoint */
export const createResponses = async (
  payload: ResponsesPayload,
  opts?: CreateResponsesOptions,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareResponsesRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: sanitizeHeadersForHistory(prepared.headers),
  })
  const { wire } = prepared
  let usedFallback = false

  if (wire.stream && canUseUpstreamWebSocket(opts?.resolvedModel)) {
    const result = await tryUpstreamWebSocket(prepared, opts)
    if (result.kind === "ok") {
      opts?.onTransport?.("upstream-ws")
      return result.generator
    }
    opts?.onTransport?.("upstream-ws-fallback")
    usedFallback = true
  }

  if (!usedFallback) {
    opts?.onTransport?.("http")
  }
  return createResponsesViaHttp(prepared, opts?.headersCapture)
}

function canUseUpstreamWebSocket(model: Model | undefined): boolean {
  const manager = getUpstreamWsManager()
  return state.upstreamWebSocket && !manager.temporarilyDisabled && !manager.stopped && isWsResponsesSupported(model)
}

type UpstreamWsAttempt = { kind: "ok"; generator: AsyncGenerator<ServerSentEventMessage> } | { kind: "fallback" }

async function tryUpstreamWebSocket(prepared: PreparedOpenAIRequest<ResponsesPayload>, opts: CreateResponsesOptions | undefined): Promise<UpstreamWsAttempt> {
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
  const wsRequestSignal = combineAbortSignals(shutdownSignal, clientAbortSignal, requestAbort.signal)

  // Forward external aborts into the local controller so finally-cleanup is consistent.
  const onExternalAbort = () => requestAbort.abort()
  shutdownSignal.addEventListener("abort", onExternalAbort, { once: true })
  clientAbortSignal?.addEventListener("abort", onExternalAbort, { once: true })

  const fetchSignal = createFetchSignal()
  const onFetchTimeout = () => {
    requestAbort.abort(new Error("Upstream WebSocket first-event timeout"))
  }
  fetchSignal?.addEventListener("abort", onFetchTimeout, { once: true })

  const detachExternal = () => {
    shutdownSignal.removeEventListener("abort", onExternalAbort)
    clientAbortSignal?.removeEventListener("abort", onExternalAbort)
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
        onComplete: () => {
          shutdownSignal.removeEventListener("abort", onExternalAbort)
          clientAbortSignal?.removeEventListener("abort", onExternalAbort)
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
  onComplete: () => void
}

async function* streamWsEvents(opts: StreamWsEventsOptions): AsyncGenerator<ServerSentEventMessage> {
  const { firstEvent, iterator, requestAbort, shutdownSignal, clientAbortSignal, onComplete } = opts
  const idleTimeoutMs = state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0
  const idleAbortSignal = combineAbortSignals(shutdownSignal, clientAbortSignal)

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

async function createResponsesViaHttp(
  prepared: PreparedOpenAIRequest<ResponsesPayload>,
  headersCapture?: HeadersCapture,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> {
  const { wire, headers } = prepared

  // Pure send/receive lives in transport/send.ts (shared with the Chat
  // Completions client). The Responses HTTP path historically did NOT fold the
  // client-abort signal into the upstream fetch, so it is omitted here to stay
  // byte-equivalent (streaming still omits the shutdown signal — the stream
  // guard in the handler owns shutdown for the streamed body).
  return (await sendUpstreamHttp({
    endpointPath: "/responses",
    headers,
    body: wire,
    stream: wire.stream,
    errorLabel: "Failed to create responses",
    modelId: wire.model,
    diagnosticsTools: wire.tools,
    headersCapture,
  })) as ResponsesResponse | AsyncGenerator<ServerSentEventMessage>
}

function toSseMessage(event: ResponsesStreamEvent): ServerSentEventMessage {
  return {
    event: event.type,
    data: JSON.stringify(event),
  }
}
