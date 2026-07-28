/**
 * v4 pipeline — upstream HTTP {@link Transport} adapter.
 *
 * Wraps the format-agnostic {@link sendUpstreamHttp} skeleton (P0.2) in the
 * driver's `Transport.send(wire, env): UpstreamStream` contract
 * (docs/v4/03-spec/retry-transport.md §4):
 *   adaptive rate-limiter → sendUpstreamHttp (fetch + captureHeaders + HTTPError)
 *   → streaming ? guardSseIterable(events) : { nonStream: json }.
 *
 * The adaptive rate-limiter wraps the fetch (429 absorbed in its queue, never
 * bubbling to the driver's retry loop — §5). `prepareWire` already produced the
 * wire (header/body trim), so this layer is pure send/receive: it derives only
 * the error label + diagnostics from the wire and never re-shapes the body.
 *
 * Per-request: the route constructs one transport per request, closing over the
 * client-disconnect signal + the history header-capture sink (P2 still samples
 * via ctx setters; P3.2 sinks `UpstreamStream.headers` through the driver).
 *
 * **Upstream WS** (Responses ws:/responses) is a later transport-internal
 * concern (retry-transport.md §4.1, P2.4) — this adapter is HTTP-only.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
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

import { ENDPOINT } from "~/lib/models/endpoint"
import { getShutdownSignal } from "~/lib/shutdown"
import {
  //
  combineAbortSignals,
  guardSseIterable,
} from "~/lib/stream"
import { createDispatchLifecycle } from "~/lib/transport/dispatch-lifecycle"
import { physicalTransportFromSend } from "~/lib/transport/physical-transport"
import { sendUpstreamHttp } from "~/lib/transport/send"

export interface UpstreamHttpTransportDeps {
  /** Client-disconnect signal, folded into the upstream fetch + the stream guard. */
  clientAbortSignal?: AbortSignal
  /** Stream idle-timeout (ms) for `guardSseIterable` (`state.streamIdleTimeout * 1000`). */
  idleTimeoutMs: number
  /**
   * When true, a shutdown-caused non-streaming fetch abort is rewritten to a
   * retryable 529 inside `sendUpstreamHttp` (parity with the legacy Anthropic
   * client). The Anthropic v4 transport opts in; CC / Responses / Gemini leave it
   * off (their AbortError flows through unchanged).
   */
  rewriteShutdownAbort?: boolean
}

/** Build an HTTP {@link Transport} for one request. */
export function createUpstreamHttpTransport(deps: UpstreamHttpTransportDeps): Transport & PhysicalTransport {
  const send: Transport["send"] = async (wire: PreparedRequest, env: RequestEnvelope, options?: TransportDispatchOptions): Promise<UpstreamStream> => {
    const lifecycle = createDispatchLifecycle(
      combineAbortSignals(options?.signal, deps.clientAbortSignal, env.ctx.lifecycleSignal, getShutdownSignal()),
      env.clientFormat,
    )
    const headers = Object.fromEntries(wire.headers.entries())
    const body = wire.body as { model?: unknown; tools?: unknown }
    // Transport-local capture: sendUpstreamHttp fills `.response` (via
    // captureHttpHeaders) so we can surface the upstream response headers as
    // `UpstreamStream.headers`. RFC Phase 2: no longer a handler-threaded bag —
    // the driver owns writing the outbound legs to ctx from `UpstreamStream.headers`
    // (success) / `apiError.responseHeaders` (failure).
    const headersCapture: HeadersCapture = {}

    let result: unknown
    try {
      result = await sendUpstreamHttp({
        // Append the forwarded client query to the upstream URL ONLY (never mutate
        // `wire.url` — `errorLabelFor(wire.url)` below relies on `=== ENDPOINT.*`).
        endpointPath: wire.url + (env.ctx.query?.forwarded ?? ""),
        headers,
        body: wire.body,
        stream: wire.stream,
        errorLabel: errorLabelFor(wire.url),
        modelId: typeof body.model === "string" ? body.model : (env.model as Model | undefined)?.id,
        diagnosticsTools: body.tools,
        headersCapture,
        clientAbortSignal: deps.clientAbortSignal,
        reaperSignal: env.ctx.lifecycleSignal,
        dispatchSignal: lifecycle.signal,
        // Best-effort h2 response-trailers capture → ctx leg (richest-data-flow).
        // node:http2 fires `trailers` before stream `end`, so it lands before the handler settles.
        onTrailers: (trailers) => env.ctx.setOutboundResponseTrailers(trailers),
        ...(deps.rewriteShutdownAbort && { rewriteShutdownAbort: true }),
      })
    } catch (error) {
      lifecycle.complete()
      throw error
    }

    // `UpstreamStream.headers` = the captured upstream response headers, read by
    // the driver to write ctx.httpHeaders.outboundResponse (RFC Phase 2).
    const responseHeaders = new Headers(headersCapture.response ?? {})

    if (!wire.stream) {
      lifecycle.complete()
      return { frames: emptyFrames(), nonStream: result, headers: responseHeaders, lifecycle }
    }

    // Streaming: wrap the raw SSE source in the idle/shutdown/client-abort guard
    // (the guard owns shutdown for the streamed body; the non-stream fetch folds
    // shutdown into its own signal inside sendUpstreamHttp). `reaperSignal`
    // (ctx.lifecycleSignal) is a DISTINCT provenance from `clientSignal` so a
    // mid-stream reaper-cancel reaches a still-connected client as an error frame
    // (StreamReaperCancelError → stream-error), never a silent client-abort (缺陷④).
    const frames = guardSseIterable(result as AsyncIterable<ServerSentEventMessage>, {
      idleTimeoutMs: deps.idleTimeoutMs,
      shutdownSignal: getShutdownSignal(),
      clientSignal: deps.clientAbortSignal,
      reaperSignal: env.ctx.lifecycleSignal,
      dispatchSignal: lifecycle.signal,
    }) as AsyncIterable<UpstreamFrame>

    return { frames: lifecycle.ownFrames(frames), headers: responseHeaders, lifecycle }
  }
  return { send, ...physicalTransportFromSend(send) }
}

/**
 * Error label matching the legacy clients (parity for the thrown `HTTPError`
 * message). Keyed on the upstream `wire.url` (= the endpoint actually called),
 * mirroring legacy parity where the chosen upstream client determines the label:
 * a CC request routed to Responses (via-responses fallback) labels as
 * "responses", and Gemini — translated to `/chat/completions` upstream — labels
 * as "chat completions" (legacy gemini used the chat-completions client; there
 * is no dedicated `generateContent` label).
 */
export function errorLabelFor(endpointPath: string): string {
  if (endpointPath === ENDPOINT.RESPONSES) return "Failed to create responses"
  if (endpointPath === ENDPOINT.MESSAGES) return "Failed to create messages"
  return "Failed to create chat completions"
}

// eslint-disable-next-line require-yield
async function* emptyFrames(): AsyncGenerator<UpstreamFrame> {
  // Non-streaming responses expose `nonStream` instead; `frames` yields nothing.
  return
}
