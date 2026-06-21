/**
 * v4 driver path for the OpenAI Responses API (P2.4).
 *
 * The Responses route dispatches here (the v4 driver path — the only path since
 * P3.3 removed the legacy `handleResponses`). Builds a per-request driver (codec
 * + WS-capable Responses transport + env strategies) and drives the seven stages.
 *
 * P2-era division of labor (sampling sinks to the driver in P3.2, mirroring CC):
 * this route still owns the response-side sampling (forwarded SSE events +
 * accumulate + complete/fail), the client-facing finishing the codec does NOT do
 * — tool-name restore (forwarded-only, post-accumulate, on the rendered Responses
 * frames), session registration — and the fallback closing lifecycle flush
 * (`codec.flushResponse`, the per-frame translator's stream-end drain). The
 * stateful `fixStreamEventIds` (DIRECT only) now runs in the driver's S5 response-
 * rewrite registry (A.C), shared with the WS transport. The error frame is built
 * inline (raw upstream message) rather than via `codec.formatError` (P2.2-D4 —
 * formatError only gets the classified kind).
 */

import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { OpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import type { HeadersCapture } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
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
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  restoreResponsesOutputToolNames,
  restoreResponsesStreamFrameToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
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
  const headersCapture: HeadersCapture = {}
  const conversationId = getSessionIdFromHeaders(c.req.raw.headers)
  const codec = createOpenAiResponsesCodec()
  const transport = createUpstreamResponsesTransport({
    headersCapture,
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
    // failure). Settle it (matching legacy's catch: setHttpHeaders + fail).
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.setHttpHeaders(headersCapture)
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
  env.ctx.setHttpHeaders(headersCapture)
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

  env.ctx.complete({
    success: true,
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
  })

  return c.json(clientResponse)
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

  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0

  /** Forward one driver-yielded Responses frame: accumulate → restore names → write. fix-stream-ids
   * (direct) is now applied upstream in the driver's S5 chain, so the yielded `rawData` is already fixed. */
  const forwardFrame = async (rawData: string, rawEvent: string | undefined): Promise<void> => {
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(rawData) as ResponsesStreamEvent
    } catch (err) {
      consola.debug(`[Responses:v4] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, rawData.slice(0, 200))
      return
    }
    accumulateResponsesStreamEvent(event, acc)
    const forwardData = restoreResponsesStreamFrameToolNames(rawData, event.type, mapper)
    forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: rawEvent ?? event.type, raw: forwardData })
    await stream.writeSSE({ event: rawEvent ?? event.type, data: forwardData })
  }

  try {
    for await (const frame of driver.runResponse(upstream, env)) {
      if (!frame.data || frame.data === "[DONE]") continue
      bytesIn += frame.data.length
      eventsIn++
      env.ctx.recordStreamProgress({ bytesIn, eventsIn })
      await forwardFrame(frame.data, frame.event)
    }

    // Fallback: drain the CC→Responses translator's closing lifecycle events
    // (output_text.done … response.completed) — the per-frame renderResponse has
    // no stream-end hook (mirrors how CC synthesizes the trailing [DONE]).
    if (viaFallback) {
      for (const closing of codec.flushResponse(env)) {
        if (!closing.data) continue
        await forwardFrame(closing.data, closing.event)
      }
    }

    // Direct registers the session after the loop with the upstream-reported id.
    if (!viaFallback) {
      if (!env.ctx.sessionId && acc.responseId) env.ctx.setSessionId(acc.responseId)
      registerResponseSession(acc.responseId, env.ctx.sessionId)
    }

    const responseData = buildResponsesResponseData(acc, model)
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    env.ctx.complete(responseData)
  } catch (error) {
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } }
    if (settleStreamingFailure({ reqCtx: env.ctx, error, model: acc.model || model, partial })) {
      consola.debug("[Responses:v4] Client disconnected mid-stream — recording aborted")
      return
    }
    consola.error("[Responses:v4] Stream error:", error)
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: streamErrorToOpenAIErrorType(error) } }),
    })
  }
}
