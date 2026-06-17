/**
 * v4 driver path for the Google Gemini endpoints (P2.5).
 *
 * The route switches to these behind the `gemini` feature flag (driver-flags);
 * the legacy `handleGenerateContent` / `handleStreamGenerateContent` stay in use
 * when the flag is off. `countTokens` is NOT a pipeline path (local tokenizer) —
 * it stays on the legacy handler.
 *
 * Gemini is a thin translation layer: the route translates Gemini→CC + injects
 * the system-prompt, the {@link createOpenAiGeminiCodec} delegates the CC-payload
 * S2–S6 to an internal openai-cc codec (incl. the via-responses bridge), and this
 * handler renders the resulting CC response/stream back to Gemini wire shape
 * (`convertOpenAIResponseToGemini` / `translateOpenAIStreamToGemini`) — keeping
 * the Gemini stream translator whole-stream (no per-frame refactor), exactly as
 * the legacy handler wrapped the CC stream.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { HeadersCapture } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  GenerateContentRequest,
  GenerateContentResponse,
} from "~/types/api/gemini"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { buildOpenAiCcStrategies } from "~/lib/codec/openai-cc-strategies"
import { createOpenAiGeminiCodec } from "~/lib/codec/openai-gemini"
import { HTTPError } from "~/lib/error"
import {
  //
  convertGeminiRequestToOpenAI,
  convertOpenAIResponseToGemini,
  translateOpenAIStreamToGemini,
} from "~/lib/gemini"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { state } from "~/lib/state"
import { classifyStreamError } from "~/lib/stream"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

/** Gemini reuses the CC strategies (network → token-refresh → auto-truncate); no learning budget. */
const MAX_LEARNING_RETRIES = 32

interface GeminiDriverBundle {
  driver: ReturnType<typeof createPipelineDriver>
  codec: ReturnType<typeof createOpenAiGeminiCodec>
  clientAbort: AbortController
  detachClientAbort: () => void
  headersCapture: HeadersCapture
}

/** Shared driver setup for both Gemini generate paths. */
function buildGeminiDriver(c: Context, modelId: string): GeminiDriverBundle {
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const headersCapture: HeadersCapture = {}
  const codec = createOpenAiGeminiCodec(modelId)
  const transport = createUpstreamHttpTransport({ headersCapture, clientAbortSignal: clientAbort.signal, idleTimeoutMs: state.streamIdleTimeout * 1000 })

  const driver = createPipelineDriver({
    codec,
    transport,
    strategies: (env) => {
      if (env.targetEndpoint === ENDPOINT.RESPONSES) env.ctx.recordFeature("via-responses")
      return buildOpenAiCcStrategies({
        originalPayload: codec.getTruncateBaseline() ?? (env.body as ChatCompletionsPayload),
        model: env.model as Model | undefined,
        maxRetries: state.autoTruncateMaxRetries,
        label: env.targetEndpoint === ENDPOINT.RESPONSES ? "Gemini(→Responses)" : "Gemini",
      })
    },
    maxRetries: state.autoTruncateMaxRetries,
    maxLearningRetries: MAX_LEARNING_RETRIES,
  })

  return { driver, codec, clientAbort, detachClientAbort, headersCapture }
}

/** Translate + run S1–S4; returns the driver result or settles the ctx + throws. */
async function runGeminiRequest(
  c: Context,
  geminiBody: GenerateContentRequest,
  modelId: string,
  stream: boolean,
): Promise<{ bundle: GeminiDriverBundle; result: Extract<DriverRequestResult, { ok: true }> }> {
  const resolvedName = resolveModelName(modelId)
  const selectedModel = state.modelIndex.get(resolvedName)

  // Translate Gemini → CC, then inject the system-prompt on the CC messages
  // (async, non-idempotent) BEFORE the sync codec.parse.
  const { payload: ccPayload } = convertGeminiRequestToOpenAI(geminiBody, { model: resolvedName, stream })
  ccPayload.messages = await processOpenAIMessages(ccPayload.messages, resolvedName)

  const bundle = buildGeminiDriver(c, modelId)
  const { driver, codec, clientAbort, detachClientAbort, headersCapture } = bundle

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: ccPayload,
      originalBodyForHistory: geminiBody,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      preResolved: { name: resolvedName, model: selectedModel },
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
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
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

  result.env.ctx.setHttpHeaders(headersCapture)
  return { bundle, result }
}

/** POST /v1beta/models/:model:generateContent (v4) */
export async function handleGenerateContentV4(c: Context, modelId: string): Promise<Response> {
  const geminiBody = await c.req.json<GenerateContentRequest>()
  const { bundle, result } = await runGeminiRequest(c, geminiBody, modelId, false)
  const { driver, detachClientAbort } = bundle
  try {
    const ccResp = driver.runResponseNonStreaming(result.upstream, result.env) as ChatCompletionResponse
    return renderGeminiNonStreamingV4(c, result.env, ccResp, modelId)
  } finally {
    detachClientAbort()
  }
}

/** POST /v1beta/models/:model:streamGenerateContent (v4) */
export async function handleStreamGenerateContentV4(c: Context, modelId: string): Promise<Response> {
  const geminiBody = await c.req.json<GenerateContentRequest>()
  const { bundle, result } = await runGeminiRequest(c, geminiBody, modelId, true)
  const { driver, detachClientAbort } = bundle

  consola.debug("[gemini:v4] Streaming response")
  result.env.ctx.transition("streaming")
  return streamSSE(c, async (stream) => {
    try {
      await pumpGeminiStreamingV4({ stream, driver, upstream: result.upstream, env: result.env, modelId })
    } finally {
      detachClientAbort()
    }
  })
}

// ============================================================================
// Non-streaming render (CC → Gemini)
// ============================================================================

function renderGeminiNonStreamingV4(c: Context, env: RequestEnvelope, chat: ChatCompletionResponse, modelId: string): Response {
  const gemini: GenerateContentResponse = convertOpenAIResponseToGemini(chat, modelId)
  const choice = chat.choices[0]
  const usage = chat.usage

  env.ctx.setForwardedResponse({ content: gemini })
  env.ctx.complete({
    success: true,
    model: chat.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }),
    },
    stop_reason: choice.finish_reason ?? undefined,
    content: choice.message,
  })

  return c.json(gemini)
}

// ============================================================================
// Streaming pump (CC → Gemini, whole-stream translator)
// ============================================================================

interface PumpGeminiStreamingV4Options {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0]
  driver: ReturnType<typeof createPipelineDriver>
  upstream: UpstreamStream
  env: RequestEnvelope
  modelId: string
}

async function pumpGeminiStreamingV4(opts: PumpGeminiStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env, modelId } = opts
  const model = (env.body as ChatCompletionsPayload).model
  let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } = {}
  let finishReason: string | undefined
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()

  try {
    // driver.runResponse yields CC frames (cc.renderResponse normalizes the
    // via-responses Responses→CC leg). Wrap them with the whole-stream Gemini
    // translator — identical to the legacy handler wrapping the CC stream.
    const ccFrames = driver.runResponse(upstream, env) as AsyncIterable<ServerSentEventMessage>
    for await (const step of translateOpenAIStreamToGemini(ccFrames, modelId)) {
      const frameData = step.frame.data ?? ""
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: "generateContent", raw: frameData })
      await stream.writeSSE({ data: frameData })
      if (step.meta?.usageMetadata) usageMetadata = step.meta.usageMetadata
      if (step.meta?.finishReason) finishReason = step.meta.finishReason
    }

    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    env.ctx.complete({
      success: true,
      model,
      usage: {
        input_tokens: usageMetadata.promptTokenCount ?? 0,
        output_tokens: usageMetadata.candidatesTokenCount ?? 0,
        ...(usageMetadata.cachedContentTokenCount !== undefined && { cache_read_input_tokens: usageMetadata.cachedContentTokenCount }),
      },
      stop_reason: finishReason,
      content: null,
    })
  } catch (error) {
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    const partial = {
      usage: {
        input_tokens: usageMetadata.promptTokenCount ?? 0,
        output_tokens: usageMetadata.candidatesTokenCount ?? 0,
        ...(usageMetadata.cachedContentTokenCount !== undefined && { cache_read_input_tokens: usageMetadata.cachedContentTokenCount }),
      },
      ...(finishReason !== undefined && { stop_reason: finishReason }),
    }
    if (settleStreamingFailure({ reqCtx: env.ctx, error, model, partial })) {
      consola.debug("[gemini:v4] Client disconnected mid-stream — recording aborted")
      return
    }
    consola.error("[gemini:v4] Stream error:", error)
    // Gemini-shape data-only error frame (SDK clients parse every data: frame).
    const message = error instanceof Error ? error.message : String(error)
    const errorKind = classifyStreamError(error)
    const errorCode = errorKind === "shutdown" ? 503 : 500
    const errorStatus = geminiStreamErrorStatus(errorKind)
    await stream.writeSSE({
      data: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
        error: { code: errorCode, message, status: errorStatus },
      }),
    })
  }
}

/** Map a streaming error kind to the Gemini gRPC `status` string (matches legacy). */
function geminiStreamErrorStatus(kind: ReturnType<typeof classifyStreamError>): string {
  switch (kind) {
    case "idle-timeout": {
      return "DEADLINE_EXCEEDED"
    }
    case "shutdown": {
      return "UNAVAILABLE"
    }
    default: {
      return "INTERNAL"
    }
  }
}
