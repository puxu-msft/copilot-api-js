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
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { ENDPOINT } from "~/lib/models/endpoint"
import { getShutdownSignal } from "~/lib/shutdown"
import { guardSseIterable } from "~/lib/stream"
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
export function createUpstreamHttpTransport(deps: UpstreamHttpTransportDeps): Transport {
  return {
    async send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream> {
      const headers = Object.fromEntries(wire.headers.entries())
      const body = wire.body as { model?: unknown; tools?: unknown }
      // Transport-local capture: sendUpstreamHttp fills `.response` (via
      // captureHttpHeaders) so we can surface the upstream response headers as
      // `UpstreamStream.headers`. RFC Phase 2: no longer a handler-threaded bag —
      // the driver owns writing the outbound legs to ctx from `UpstreamStream.headers`
      // (success) / `apiError.responseHeaders` (failure).
      const headersCapture: HeadersCapture = {}

      const { result, queueWaitMs } = await executeWithAdaptiveRateLimit(() =>
        sendUpstreamHttp({
          endpointPath: wire.url,
          headers,
          body: wire.body,
          stream: wire.stream,
          errorLabel: errorLabelFor(wire.url),
          modelId: typeof body.model === "string" ? body.model : (env.model as Model | undefined)?.id,
          diagnosticsTools: body.tools,
          headersCapture,
          clientAbortSignal: deps.clientAbortSignal,
          reaperSignal: env.ctx.lifecycleSignal,
          // Best-effort h2 response-trailers capture → ctx leg (richest-data-flow).
          // node:http2 fires `trailers` before stream `end`, so it lands before the handler settles.
          onTrailers: (trailers) => env.ctx.setOutboundResponseTrailers(trailers),
          ...(deps.rewriteShutdownAbort && { rewriteShutdownAbort: true }),
        }),
      )
      // P2.3-S: record rate-limiter queue wait on the ctx (legacy parity —
      // pipeline.ts `addQueueWaitMs`).
      env.ctx.addQueueWaitMs(queueWaitMs)

      // `UpstreamStream.headers` = the captured upstream response headers, read by
      // the driver to write ctx.httpHeaders.outboundResponse (RFC Phase 2).
      const responseHeaders = new Headers(headersCapture.response ?? {})

      if (!wire.stream) {
        return { frames: emptyFrames(), nonStream: result, headers: responseHeaders }
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
      }) as AsyncIterable<UpstreamFrame>

      return { frames, headers: responseHeaders }
    },
  }
}

/** Error label matching the legacy clients (parity for the thrown `HTTPError` message). */
function errorLabelFor(endpointPath: string): string {
  return endpointPath === ENDPOINT.RESPONSES ? "Failed to create responses" : "Failed to create chat completions"
}

// eslint-disable-next-line require-yield
async function* emptyFrames(): AsyncGenerator<UpstreamFrame> {
  // Non-streaming responses expose `nonStream` instead; `frames` yields nothing.
  return
}
