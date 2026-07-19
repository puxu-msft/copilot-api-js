/**
 * v4 pipeline — Responses {@link Transport} with the upstream HTTP-vs-WS second
 * choice (docs/v4/03-spec/retry-transport.md §4.1).
 *
 * Unlike the format-agnostic {@link createUpstreamHttpTransport} (CC), the
 * Responses path has a transport-internal second choice: a streaming request to
 * a WS-capable model may go over an upstream WebSocket (pool/reuse/circuit-break,
 * `upstream-ws-attempt.ts`) instead of HTTP, degrading to HTTP on failure. This
 * choice is INTERNAL to the transport — the driver and codec stay format-agnostic
 * and never see it (retry-transport.md §4.1):
 *
 *   send(wire, env, opts):
 *     wire.stream && canUseUpstreamWebSocket(model) && !opts.forceHttp
 *       ? attemptUpstreamResponsesWs → ok: report "upstream-ws", frames
 *                                     fallback: throw typed scheduler control flow
 *       : report "http", one sendUpstreamHttp call
 *
 * The driver turns the typed before-first-event fallback into a fresh, separately
 * admitted HTTP dispatch. Legacy `createResponses` keeps its own fallback path.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { RequestTransport } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  PhysicalTransport,
  Transport,
  TransportDispatchOptions,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import {
  //
  attemptUpstreamResponsesWs,
  canUseUpstreamWebSocket,
} from "~/lib/openai/upstream-ws-attempt"
import { getShutdownSignal } from "~/lib/shutdown"
import {
  //
  combineAbortSignals,
  guardSseIterable,
} from "~/lib/stream"
import { createDispatchLifecycle } from "~/lib/transport/dispatch-lifecycle"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"
import { physicalTransportFromSend } from "~/lib/transport/physical-transport"
import { sendUpstreamHttp } from "~/lib/transport/send"

export interface UpstreamResponsesTransportDeps {
  /** Client-disconnect signal, folded into the stream guard + the WS request. */
  clientAbortSignal?: AbortSignal
  /** Stream idle-timeout (ms) for `guardSseIterable` (`state.streamIdleTimeout * 1000`). */
  idleTimeoutMs: number
  /** Fallback upstream-WS reuse key when `previous_response_id` is absent. */
  conversationId?: string
}

/** Build a Responses {@link Transport} (HTTP + upstream-WS) for one request. */
export function createUpstreamResponsesTransport(deps: UpstreamResponsesTransportDeps): Transport & PhysicalTransport {
  const send: Transport["send"] = (wire, env, options) => selectAndSend(wire, env, deps, options)
  return { send, ...physicalTransportFromSend(send) }
}

/** Execute exactly one physical WS or HTTP dispatch. Fallback is surfaced to the driver. */
async function selectAndSend(
  wire: PreparedRequest,
  env: RequestEnvelope,
  deps: UpstreamResponsesTransportDeps,
  options?: TransportDispatchOptions,
): Promise<UpstreamStream> {
  const responsesPayload = wire.body as ResponsesPayload
  const headers = Object.fromEntries(wire.headers.entries())
  const model = env.model as Model | undefined
  // Reaper signal (缺陷④): DISTINCT provenance from clientAbort, folded into BOTH the
  // upstream WS request / HTTP fetch (cancel the in-flight) and the stream guard (a
  // mid-stream reap reaches a live client as reaper-cancel → stream-error → error frame).
  const reaperSignal = env.ctx.lifecycleSignal

  if (!options?.forceHttp && wire.stream && canUseUpstreamWebSocket(model, responsesPayload.model)) {
    reportTransport(env, "upstream-ws")
    const attempt = await attemptUpstreamResponsesWs(
      { wire: responsesPayload, headers },
      { conversationId: deps.conversationId, clientAbortSignal: deps.clientAbortSignal, reaperSignal, dispatchSignal: options?.signal },
    )
    if (attempt.kind === "ok") {
      return {
        frames: guardWsOrHttp(attempt.generator, deps, reaperSignal, options?.signal),
        headers: new Headers(),
        lifecycle: attempt.lifecycle,
      }
    }
    // Request-wide cancellation must never be converted into a fresh HTTP dispatch.
    if (deps.clientAbortSignal?.aborted || reaperSignal.aborted || options?.signal?.aborted || getShutdownSignal().aborted) {
      throw attempt.error instanceof Error ? attempt.error : new DOMException("The operation was aborted.", "AbortError")
    }
    throw new UpstreamTransportFallbackError("ws-before-first-event", attempt.error)
  }

  reportTransport(env, "http")
  return sendViaHttp(wire, deps, reaperSignal, options?.signal)
}

/** Report the chosen transport on the ctx attempt (legacy `onTransport` → `setAttemptTransport`). */
function reportTransport(env: RequestEnvelope, transport: RequestTransport): void {
  env.ctx.setAttemptTransport(transport)
}

/** HTTP send: pure fetch (no client-abort folded in — Responses-historical) + guard on stream. */
async function sendViaHttp(
  wire: PreparedRequest,
  deps: UpstreamResponsesTransportDeps,
  reaperSignal?: AbortSignal,
  dispatchSignal?: AbortSignal,
): Promise<UpstreamStream> {
  const lifecycle = createDispatchLifecycle(combineAbortSignals(dispatchSignal, deps.clientAbortSignal, reaperSignal, getShutdownSignal()))
  // Transport-local capture (RFC Phase 2 — no handler-threaded bag); fills `.response`
  // so we can surface upstream response headers as `UpstreamStream.headers` (read by
  // the driver to write ctx.httpHeaders.outboundResponse).
  const headersCapture: HeadersCapture = {}
  let result: unknown
  try {
    result = await sendUpstreamHttp({
      endpointPath: wire.url,
      headers: Object.fromEntries(wire.headers.entries()),
      body: wire.body,
      stream: wire.stream,
      errorLabel: "Failed to create responses",
      modelId: (wire.body as { model?: unknown }).model as string | undefined,
      diagnosticsTools: (wire.body as { tools?: unknown }).tools,
      headersCapture,
      reaperSignal,
      dispatchSignal: lifecycle.signal,
    })
  } catch (error) {
    lifecycle.complete()
    throw error
  }

  const responseHeaders = new Headers(headersCapture.response ?? {})

  if (!wire.stream) {
    lifecycle.complete()
    return { frames: emptyFrames(), nonStream: result, headers: responseHeaders, lifecycle }
  }

  const frames = guardWsOrHttp(result as AsyncIterable<ServerSentEventMessage>, deps, reaperSignal, lifecycle.signal)
  return { frames: lifecycle.ownFrames(frames), headers: responseHeaders, lifecycle }
}

/** Wrap the raw upstream SSE source (WS generator or HTTP events) in the idle/shutdown/client/reaper guard. */
function guardWsOrHttp(
  source: AsyncIterable<ServerSentEventMessage>,
  deps: UpstreamResponsesTransportDeps,
  reaperSignal?: AbortSignal,
  dispatchSignal?: AbortSignal,
): AsyncIterable<UpstreamFrame> {
  return guardSseIterable(source, {
    idleTimeoutMs: deps.idleTimeoutMs,
    shutdownSignal: getShutdownSignal(),
    clientSignal: deps.clientAbortSignal,
    reaperSignal,
    dispatchSignal,
  }) as AsyncIterable<UpstreamFrame>
}

// eslint-disable-next-line require-yield
async function* emptyFrames(): AsyncGenerator<UpstreamFrame> {
  // Non-streaming responses expose `nonStream` instead; `frames` yields nothing.
  return
}
