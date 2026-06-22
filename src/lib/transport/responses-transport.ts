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
 *   send(wire, env):
 *     rate-limiter wraps:
 *       wire.stream && canUseUpstreamWebSocket(model)
 *         ? attemptUpstreamResponsesWs → ok: report "upstream-ws", frames
 *                                       fallback: report "upstream-ws-fallback", HTTP
 *         : report "http", HTTP (sendUpstreamHttp)
 *     → streaming ? guardSseIterable(frames) : { nonStream: json }
 *
 * Lifts the legacy `createResponses` selection (responses-client.ts) into the
 * driver's `Transport` contract. Byte-equivalent to legacy: the HTTP path omits
 * the client-abort signal from the upstream fetch (Responses-historical — the
 * stream guard owns client-abort for the streamed body), and the whole
 * select-and-send runs inside the adaptive rate-limiter exactly as legacy wrapped
 * `createResponses`.
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
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import {
  //
  attemptUpstreamResponsesWs,
  canUseUpstreamWebSocket,
} from "~/lib/openai/upstream-ws-attempt"
import { getShutdownSignal } from "~/lib/shutdown"
import { guardSseIterable } from "~/lib/stream"
import { sendUpstreamHttp } from "~/lib/transport/send"

export interface UpstreamResponsesTransportDeps {
  /**
   * History header-capture sink (HTTP path only — WS has no HTTP response
   * headers). `sendUpstreamHttp` fills it; the adapter surfaces the captured
   * response headers as `UpstreamStream.headers`.
   */
  headersCapture?: HeadersCapture
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
    async send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream> {
      // The whole select-and-send runs inside the adaptive rate-limiter — legacy
      // wrapped `createResponses` (which contains the same WS-or-HTTP selection)
      // in `executeWithAdaptiveRateLimit`.
      const { result, queueWaitMs } = await executeWithAdaptiveRateLimit(() => selectAndSend(wire, env, deps))
      env.ctx.addQueueWaitMs(queueWaitMs)
      return result
    },
  }
}

/** Choose upstream WS or HTTP, report the chosen transport on ctx, and return the stream. */
async function selectAndSend(wire: PreparedRequest, env: RequestEnvelope, deps: UpstreamResponsesTransportDeps): Promise<UpstreamStream> {
  const responsesPayload = wire.body as ResponsesPayload
  const headers = Object.fromEntries(wire.headers.entries())
  const model = env.model as Model | undefined
  // Reaper signal (缺陷④): DISTINCT provenance from clientAbort, folded into BOTH the
  // upstream WS request / HTTP fetch (cancel the in-flight) and the stream guard (a
  // mid-stream reap reaches a live client as reaper-cancel → stream-error → error frame).
  const reaperSignal = env.ctx.lifecycleSignal

  if (wire.stream && canUseUpstreamWebSocket(model)) {
    const attempt = await attemptUpstreamResponsesWs(
      { wire: responsesPayload, headers },
      { conversationId: deps.conversationId, clientAbortSignal: deps.clientAbortSignal, reaperSignal },
    )
    if (attempt.kind === "ok") {
      reportTransport(env, "upstream-ws")
      return { frames: guardWsOrHttp(attempt.generator, deps, reaperSignal), headers: new Headers() }
    }
    reportTransport(env, "upstream-ws-fallback")
  } else {
    reportTransport(env, "http")
  }

  return sendViaHttp(wire, deps, reaperSignal)
}

/** Report the chosen transport on the ctx attempt (legacy `onTransport` → `setAttemptTransport`). */
function reportTransport(env: RequestEnvelope, transport: RequestTransport): void {
  env.ctx.setAttemptTransport(transport)
}

/** HTTP send: pure fetch (no client-abort folded in — Responses-historical) + guard on stream. */
async function sendViaHttp(wire: PreparedRequest, deps: UpstreamResponsesTransportDeps, reaperSignal?: AbortSignal): Promise<UpstreamStream> {
  const result = await sendUpstreamHttp({
    endpointPath: wire.url,
    headers: Object.fromEntries(wire.headers.entries()),
    body: wire.body,
    stream: wire.stream,
    errorLabel: "Failed to create responses",
    modelId: (wire.body as { model?: unknown }).model as string | undefined,
    diagnosticsTools: (wire.body as { tools?: unknown }).tools,
    headersCapture: deps.headersCapture,
    reaperSignal,
  })

  const responseHeaders = new Headers(deps.headersCapture?.response ?? {})

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
