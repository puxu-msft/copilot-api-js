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
import { guardSseIterable } from "~/lib/stream"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"
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
export function createUpstreamResponsesTransport(deps: UpstreamResponsesTransportDeps): Transport {
  return {
    async send(wire: PreparedRequest, env: RequestEnvelope, options?: TransportDispatchOptions): Promise<UpstreamStream> {
      return selectAndSend(wire, env, deps, options)
    },
  }
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
      { conversationId: deps.conversationId, clientAbortSignal: deps.clientAbortSignal, reaperSignal },
    )
    if (attempt.kind === "ok") {
      return { frames: guardWsOrHttp(attempt.generator, deps, reaperSignal), headers: new Headers() }
    }
    // Request-wide cancellation must never be converted into a fresh HTTP dispatch.
    if (deps.clientAbortSignal?.aborted || reaperSignal.aborted || getShutdownSignal().aborted) {
      throw attempt.error instanceof Error ? attempt.error : new DOMException("The operation was aborted.", "AbortError")
    }
    throw new UpstreamTransportFallbackError("ws-before-first-event", attempt.error)
  }

  reportTransport(env, "http")
  return sendViaHttp(wire, deps, reaperSignal)
}

/** Report the chosen transport on the ctx attempt (legacy `onTransport` → `setAttemptTransport`). */
function reportTransport(env: RequestEnvelope, transport: RequestTransport): void {
  env.ctx.setAttemptTransport(transport)
}

/** HTTP send: pure fetch (no client-abort folded in — Responses-historical) + guard on stream. */
async function sendViaHttp(wire: PreparedRequest, deps: UpstreamResponsesTransportDeps, reaperSignal?: AbortSignal): Promise<UpstreamStream> {
  // Transport-local capture (RFC Phase 2 — no handler-threaded bag); fills `.response`
  // so we can surface upstream response headers as `UpstreamStream.headers` (read by
  // the driver to write ctx.httpHeaders.outboundResponse).
  const headersCapture: HeadersCapture = {}
  const result = await sendUpstreamHttp({
    endpointPath: wire.url,
    headers: Object.fromEntries(wire.headers.entries()),
    body: wire.body,
    stream: wire.stream,
    errorLabel: "Failed to create responses",
    modelId: (wire.body as { model?: unknown }).model as string | undefined,
    diagnosticsTools: (wire.body as { tools?: unknown }).tools,
    headersCapture,
    reaperSignal,
  })

  const responseHeaders = new Headers(headersCapture.response ?? {})

  if (!wire.stream) {
    return { frames: emptyFrames(), nonStream: result, headers: responseHeaders }
  }

  return { frames: guardWsOrHttp(result as AsyncIterable<ServerSentEventMessage>, deps, reaperSignal), headers: responseHeaders }
}

/** Wrap the raw upstream SSE source (WS generator or HTTP events) in the idle/shutdown/client/reaper guard. */
function guardWsOrHttp(
  source: AsyncIterable<ServerSentEventMessage>,
  deps: UpstreamResponsesTransportDeps,
  reaperSignal?: AbortSignal,
): AsyncIterable<UpstreamFrame> {
  return guardSseIterable(source, {
    idleTimeoutMs: deps.idleTimeoutMs,
    shutdownSignal: getShutdownSignal(),
    clientSignal: deps.clientAbortSignal,
    reaperSignal,
  }) as AsyncIterable<UpstreamFrame>
}

// eslint-disable-next-line require-yield
async function* emptyFrames(): AsyncGenerator<UpstreamFrame> {
  // Non-streaming responses expose `nonStream` instead; `frames` yields nothing.
  return
}
