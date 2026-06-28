/**
 * v4 driver path for the OpenAI Responses API (P2.4).
 *
 * The Responses route dispatches here (the v4 driver path — the only path since
 * P3.3 removed the legacy `handleResponses`). Builds a per-request driver (codec
 * + WS-capable Responses transport + env strategies) and drives the seven stages.
 *
 * Division of labor (Stage B Responses-HTTP cut-over — owns-the-sink streaming): the DRIVER
 * owns the client write-out (`runResponseSink` writes each rendered frame to a `makeSseSink`);
 * this route does the rendered-frame-side work through the driver's `onRenderedFrame` hook
 * (accumulate + progress + the forwarded-only tool-name restore on the rendered Responses
 * frames; `undefined` return skips empty/unparseable frames), samples the forwarded track
 * inside the sink (`onForwarded`), and after a clean drain handles the format-specific
 * finishing the codec/driver do NOT: the fallback closing-lifecycle flush (`codec.flushResponse`,
 * the CC→Responses translator's stream-end drain — kept handler-side; see
 * docs/archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md for why the "move flush into the driver
 * S6 flush" idea was evaluated and rejected) and session registration (fallback eager pre-stream;
 * direct post-loop via `acc.responseId`). The stateful `fixStreamEventIds` (DIRECT only) runs in the driver's S5
 * response-rewrite registry (A.C), shared with the WS transport. The error frame is built
 * inline (raw upstream message) rather than via `codec.formatError` (P2.2-D4). Responses has
 * no `[DONE]` (it ends with `response.completed`) and no H2 (the accumulator tracks no
 * `streamError`), so the only failure paths are H3 (`stream-error`) / client-abort.
 */

import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { OpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import type { SseEventRecord } from "~/lib/history/store"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { RESPONSES_RESPONSE_REWRITES } from "~/lib/codec/openai-responses/response-rewrites"
import { buildOpenAiResponsesStrategiesForEnv } from "~/lib/codec/openai-responses/strategies"
import { HTTPError } from "~/lib/error"
import {
  //
  getSessionIdFromHeaders,
  registerResponseSession,
} from "~/lib/history/store"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { responsesOutputToContent } from "~/lib/openai/responses-conversion"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"
import {
  //
  restoreResponsesOutputToolNames,
  restoreResponsesStreamFrameToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { responsesNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { state } from "~/lib/state"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

/** Responses has no learning-budget strategy; the value is inert (passed for completeness). */
const MAX_LEARNING_RETRIES = 32

export async function handleResponsesV4(c: Context): Promise<Response> {
  const clientRaw = (c.get("injectedPayload") as ResponsesPayload | undefined) ?? (await c.req.json<ResponsesPayload>())
  const azureModelOverride = c.get("azureModelOverride") as string | undefined

  // Apply the async, non-idempotent system-prompt injection (instructions) BEFORE
  // the sync codec.parse, passing the client raw separately for the history
  // snapshot. Resolve the model HERE (before processResponsesInstructions' config
  // reload) and pass it as `preResolved` — matching the legacy handler's order.
  const resolvedName = resolveModelName(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)
  const wireInstructions = await processResponsesInstructions(clientRaw.instructions, resolvedName)
  const wireBody: ResponsesPayload = { ...clientRaw, instructions: wireInstructions }

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const conversationId = getSessionIdFromHeaders(c.req.raw.headers)
  const codec = createOpenAiResponsesCodec()
  const transport = createUpstreamResponsesTransport({
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: state.streamIdleTimeout * 1000,
    ...(conversationId !== undefined && { conversationId }),
  })

  const driver = createPipelineDriver({
    codec,
    transport,
    // S5 — the Responses response-rewrite chain (fix-stream-ids, DIRECT only). The driver
    // applies it before render (A.C); the handler forwards the yielded (fixed) frames. Tool-name
    // restore stays handler-side (forwarded-only, post-accumulate, must run on rendered frames).
    responseRewrites: RESPONSES_RESPONSE_REWRITES,
    strategies: (env) => {
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) env.ctx.recordFeature("via-chat-completions-fallback")
      return buildOpenAiResponsesStrategiesForEnv(env)
    },
    maxRetries: 1,
    maxLearningRetries: MAX_LEARNING_RETRIES,
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: wireBody,
      originalBodyForHistory: clientRaw,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      preResolved: { name: resolvedName, model: selectedModel },
      ...(azureModelOverride !== undefined && { modelOverride: azureModelOverride }),
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Any failure after parse created the ctx (parse-period throw, or an exchange
    // failure). Settle it. (Outbound header legs are written by the driver during
    // the exchange, RFC Phase 2.)
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.fail(resolvedName, error)
    }
    detachClientAbort()
    throw error
  }

  const ctx = codec.getContext()
  if (ctx) c.set("requestContext", ctx)

  if (!result.ok) {
    // decideRoute reject — shape the OpenAI 400 (route's forwardError finishes it).
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

  const { upstream, env } = result
  const viaFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS

  if (!env.stream) {
    try {
      const resp = driver.runResponseNonStreaming(upstream, env) as ResponsesResponse
      return renderNonStreamingV4(c, env, resp)
    } finally {
      detachClientAbort()
    }
  }

  consola.debug("[Responses:v4] Streaming response")
  env.ctx.transition("streaming")

  // Fallback eagerly registers the session BEFORE the stream so a follow-up
  // request using `previous_response_id` mid-stream can resolve it (parity with
  // the legacy fallback). The direct path registers after the loop (acc.responseId).
  if (viaFallback) {
    const respId = codec.getFallbackResponseId()
    if (respId) {
      if (!env.ctx.sessionId) env.ctx.setSessionId(respId)
      registerResponseSession(respId, env.ctx.sessionId)
    }
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => clientAbort.abort())
    // RFC Phase 4: ④ capture proxy→client response headers (set by streamSSE before this callback).
    env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    try {
      await pumpStreamingV4({ stream, driver, codec, upstream, env, viaFallback })
    } finally {
      detachClientAbort()
    }
  })
}

// ============================================================================
// Non-streaming render
// ============================================================================

function renderNonStreamingV4(c: Context, env: RequestEnvelope, resp: ResponsesResponse): Response {
  // Direct: register with the upstream resp.id when no session yet. Fallback: the
  // resp.id is the handler's synthesized responseId.
  if (!env.ctx.sessionId && resp.id) env.ctx.setSessionId(resp.id)
  registerResponseSession(resp.id, env.ctx.sessionId)

  // Restore function_call names (upstream → original) on the client-facing
  // response. Computed before complete() so the forwarded content is recorded;
  // complete() records the upstream-original content.
  const clientResponse = restoreResponsesOutputToolNames(resp, env.ctx.toolNameMapper)
  env.ctx.setForwardedResponse({ content: responsesOutputToContent(clientResponse.output) })

  // RFC Phase 4: ④ build the client response first, capture its headers, THEN complete.
  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))

  // Non-streaming semantic-truncation gate (missing / in_progress status → fail, not silent complete).
  const truncationReason = responsesNonStreamingTruncation(resp.status)
  const responseData = {
    success: !truncationReason,
    model: resp.model,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
      ...(resp.usage?.input_tokens_details?.cached_tokens && { cache_read_input_tokens: resp.usage.input_tokens_details.cached_tokens }),
      ...(resp.usage?.output_tokens_details?.reasoning_tokens && {
        output_tokens_details: { reasoning_tokens: resp.usage.output_tokens_details.reasoning_tokens },
      }),
    },
    stop_reason: resp.status,
    content: responsesOutputToContent(resp.output),
  }
  if (truncationReason) {
    env.ctx.fail(resp.model, new Error(truncationReason), { usage: responseData.usage, stop_reason: responseData.stop_reason, content: responseData.content })
  } else {
    env.ctx.complete(responseData)
  }

  return httpResponse
}

// ============================================================================
// Streaming pump
// ============================================================================

interface PumpStreamingV4Options {
  stream: SSEStreamingApi
  driver: ReturnType<typeof createPipelineDriver>
  codec: OpenAiResponsesCodec
  upstream: UpstreamStream
  env: RequestEnvelope
  viaFallback: boolean
}

async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, codec, upstream, env, viaFallback } = opts
  const acc = createResponsesStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
  const model = (env.body as ResponsesPayload).model

  // Forwarded SSE frames — what the client ACTUALLY received (tool-name restored). Filled by
  // the sink's `onForwarded` sampler; the upstream-original track is the driver's (runResponse
  // loop-top samples the raw frames before render). No heartbeat (Responses has none).
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0

  const sink = makeSseSink(stream, { onForwarded: (record) => forwardedSseEvents.push(record), streamStartMs })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  /**
   * Accumulate one rendered Responses frame + restore function_call names (forwarded-only).
   * Returns the restored frame to forward, or `undefined` to skip (empty / unparseable —
   * the legacy loop's `!frame.data` guard + `forwardFrame`'s parse-fail early return).
   * fix-stream-ids (direct) was already applied in the driver's S5 chain. Shared by the driver
   * loop (via `onRenderedFrame`, which adds progress counting) AND the fallback closing drain.
   */
  const restoreAndAccumulate = (frame: ClientFrame): ClientFrame | undefined => {
    if (!frame.data) return undefined
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(frame.data) as ResponsesStreamEvent
    } catch (err) {
      consola.debug(`[Responses:v4] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, frame.data.slice(0, 200))
      return undefined
    }
    accumulateResponsesStreamEvent(event, acc)
    // Wire `event:` line = `frame.event ?? event.type` (byte-identical to the legacy forwardFrame).
    // The forwarded HISTORY-record `type` is derived by the sink's `frameType` (parsed-JSON-`type`-
    // first), vs the legacy record's `rawEvent ?? event.type` (event-line-first) — these agree for
    // every compliant Responses frame (the SSE `event:` line mirrors the JSON `type`); they'd only
    // differ in the history label (never the wire) for a malformed upstream where `event:` ≠ `type`.
    return { event: frame.event ?? event.type, data: restoreResponsesStreamFrameToolNames(frame.data, event.type, mapper) }
  }

  // Driver-loop hook: progress counting (loop frames only, mirroring the legacy loop body —
  // the fallback closing drain did NOT count) + restore/accumulate. Skips empty BEFORE counting
  // (legacy pre-count `!frame.data` guard); a parse-fail counts but does not forward (legacy).
  const onRenderedFrame = (frame: ClientFrame): ClientFrame | undefined => {
    if (!frame.data) return undefined
    bytesIn += frame.data.length
    eventsIn++
    env.ctx.recordStreamProgress({ bytesIn, eventsIn })
    return restoreAndAccumulate(frame)
  }

  const outcome = await driver.runResponseSink(upstream, env, sink, { onRenderedFrame })

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[Responses:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } })
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — settle as fail (partial usage) + write the OpenAI error frame through the
    // NON-sampling writeSynthetic path (legacy never pushed the error frame to forwarded).
    recordForwarded()
    const error = outcome.error
    env.ctx.fail(acc.model || model, error, { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } })
    consola.error("[Responses:v4] Stream error:", error)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error))
    return
  }

  // outcome.kind === "complete" — the upstream drained cleanly.
  if (viaFallback) {
    // Drain the CC→Responses translator's closing lifecycle (output_text.done … response.completed)
    // — the per-frame renderResponse has no stream-end hook (mirrors how CC synthesizes [DONE]).
    // Each closing frame goes through restoreAndAccumulate (response.completed sets responseId/usage)
    // + the sink (sampled). Not progress-counted (legacy `forwardFrame` drain did not count).
    // (Kept handler-side: the "move this into a driver S6 flush" idea was evaluated and rejected —
    // the stream-end terminal handling is entangled with format-specific truncation detection +
    // ctx settling, so a uniform driver flush is over-engineering. See
    // docs/archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md.)
    for (const closing of codec.flushResponse(env)) {
      const out = restoreAndAccumulate(closing)
      if (out) await sink.write(out)
    }
  } else {
    // Direct registers the session after the loop with the upstream-reported id.
    if (!env.ctx.sessionId && acc.responseId) env.ctx.setSessionId(acc.responseId)
    registerResponseSession(acc.responseId, env.ctx.sessionId)
  }

  // Truncation: a complete Responses stream ALWAYS carries a terminal `response.completed` /
  // `.incomplete` / `.failed` (all three set `acc.status`). An empty `acc.status` after a clean
  // drain means the upstream truncated before any terminal — settle FAIL (preserving the partial)
  // + emit a Responses error frame so the client gets a clean terminator. Checked AFTER the
  // viaFallback drain (whose synthesized closing lifecycle sets `acc.status`), so a real direct
  // truncation is caught while a normal fallback close is not. (A truncated *underlying CC*
  // stream under fallback still gets a synthesized `response.completed` here — that narrower gap
  // is documented in docs/rfc/upstream-stream-truncation-detection.md §3.1/Q2.)
  if (acc.status === "") {
    recordForwarded()
    const partial = buildResponsesResponseData(acc, model)
    const truncErr = new Error("Upstream stream truncated before completion (no response.completed)")
    consola.error(`[Responses:v4] Upstream truncated for ${acc.model || model}: drained without a terminal response event`)
    env.ctx.fail(acc.model || model, truncErr, { usage: partial.usage, content: partial.content })
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr))
    return
  }

  recordForwarded()
  env.ctx.complete(buildResponsesResponseData(acc, model))
}
