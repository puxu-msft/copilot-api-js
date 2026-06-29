/**
 * v4 driver path for the Google Gemini endpoints (P2.5).
 *
 * The Gemini route dispatches generateContent / streamGenerateContent here (the
 * v4 driver path — the only path since P3.3 removed the legacy handlers).
 * `countTokens` is NOT a pipeline path (local tokenizer) — it stays on the
 * sibling `handler.ts`.
 *
 * Gemini is a thin translation layer: the route translates Gemini→CC + injects
 * the system-prompt, the {@link createOpenAiGeminiCodec} delegates the CC-payload
 * S2–S6 to an internal openai-cc codec (incl. the via-responses bridge), and — since
 * Stage B B5 — the codec's `renderResponse` ALSO does the per-frame CC→Gemini render
 * (`createGeminiStreamTranslator`, formerly the handler's whole-stream wrapper), so the
 * owns-the-sink driver writes Gemini frames directly. The streaming handler reads the
 * terminal usage/finishReason out-of-band via `codec.getStreamMeta()` and drains the
 * stream-end frames via `codec.flushResponse`. The non-streaming path still renders
 * CC → Gemini inline (`convertOpenAIResponseToGemini`).
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { OpenAiGeminiCodec } from "~/lib/codec/openai-gemini/codec"
import type { SseEventRecord } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
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
import { buildOpenAiCcStrategies } from "~/lib/codec/openai-cc/strategies"
import { createOpenAiGeminiCodec } from "~/lib/codec/openai-gemini/codec"
import { HTTPError } from "~/lib/error"
import {
  //
  convertGeminiRequestToOpenAI,
  convertOpenAIResponseToGemini,
} from "~/lib/gemini"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { openaiNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import { state } from "~/lib/state"
import { classifyStreamError } from "~/lib/stream"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"
import { resolveInboundQuery } from "~/lib/transport/query-forward"

/** Gemini reuses the CC strategies (network → token-refresh → auto-truncate); no learning budget. */
const MAX_LEARNING_RETRIES = 32

interface GeminiDriverBundle {
  driver: ReturnType<typeof createPipelineDriver>
  codec: ReturnType<typeof createOpenAiGeminiCodec>
  clientAbort: AbortController
  detachClientAbort: () => void
}

/** Shared driver setup for both Gemini generate paths. */
function buildGeminiDriver(c: Context, modelId: string): GeminiDriverBundle {
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const codec = createOpenAiGeminiCodec(modelId)
  const transport = createUpstreamHttpTransport({ clientAbortSignal: clientAbort.signal, idleTimeoutMs: state.streamIdleTimeout * 1000 })

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

  return { driver, codec, clientAbort, detachClientAbort }
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
  const { driver, codec, clientAbort, detachClientAbort } = bundle

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: ccPayload,
      originalBodyForHistory: geminiBody,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      query: resolveInboundQuery(c.req.url),
      preResolved: { name: resolvedName, model: selectedModel },
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Outbound header legs are written by the driver during the exchange (RFC Phase 2).
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
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

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
  const { driver, codec, clientAbort, detachClientAbort } = bundle

  consola.debug("[gemini:v4] Streaming response")
  result.env.ctx.transition("streaming")
  return streamSSE(c, async (stream) => {
    // streamSSE.onAbort is the second client-disconnect trigger source — the
    // inbound HTTP signal bridge (buildGeminiDriver) is the first. Both are needed:
    // a write-side streamSSE abort is distinct from c.req.raw.signal (parity with
    // legacy renderGeminiStreaming + the CC/Responses v4 handlers).
    stream.onAbort(() => clientAbort.abort())
    // RFC Phase 4: ④ capture proxy→client response headers (set by streamSSE before this callback).
    result.env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    try {
      await pumpGeminiStreamingV4({ stream, driver, codec, upstream: result.upstream, env: result.env })
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
  const choice = chat.choices.at(0)
  const usage = chat.usage

  env.ctx.setForwardedResponse({ content: gemini })
  // RFC Phase 4: ④ build the client response first, capture its headers, THEN complete.
  const httpResponse = c.json(gemini)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))

  // Non-streaming semantic-truncation gate (Gemini renders from a CC response → check
  // finish_reason; `.at(0)` so an empty choices array flows through as a fail, not a throw).
  const truncationReason = openaiNonStreamingTruncation(choice?.finish_reason)
  const responseData = {
    success: !truncationReason,
    model: chat.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }),
    },
    stop_reason: choice?.finish_reason ?? undefined,
    content: choice?.message,
  }
  if (truncationReason) {
    env.ctx.fail(chat.model, new Error(truncationReason), { usage: responseData.usage, stop_reason: responseData.stop_reason, content: responseData.content })
  } else {
    env.ctx.complete(responseData)
  }

  return httpResponse
}

// ============================================================================
// Streaming pump (CC → Gemini, whole-stream translator)
// ============================================================================

interface PumpGeminiStreamingV4Options {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0]
  driver: ReturnType<typeof createPipelineDriver>
  codec: OpenAiGeminiCodec
  upstream: UpstreamStream
  env: RequestEnvelope
}

/** Map the Gemini stream meta (codec-accumulated) → the ctx usage shape (legacy parity). */
function geminiUsageFromMeta(meta: ReturnType<OpenAiGeminiCodec["getStreamMeta"]>): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
} {
  const u = meta.usageMetadata
  return {
    input_tokens: u?.promptTokenCount ?? 0,
    output_tokens: u?.candidatesTokenCount ?? 0,
    ...(u?.cachedContentTokenCount !== undefined && { cache_read_input_tokens: u.cachedContentTokenCount }),
  }
}

/**
 * Stream pump for the v4 Gemini path — **owns-the-sink** (Stage B B5 cut-over). The driver OWNS the
 * client write-out: `runResponseSink` drives the codec's per-frame CC→Gemini translation (the former
 * whole-stream `translateOpenAIStreamToGemini`, now `createGeminiStreamTranslator` inside the codec)
 * and writes the Gemini frames to the injected {@link makeSseSink}. This handler:
 *   - samples the FORWARDED track inside the sink (`onForwarded`), hard-labeling the record `type`
 *     "generateContent" (Gemini frames carry no event/type the default `frameType` could read),
 *   - drains the translator's stream-end frames (remaining tool calls + the terminal usage/finishReason
 *     frame) via `codec.flushResponse` after a clean drain (mirrors the Responses fallback flush),
 *   - reads the terminal meta out-of-band via `codec.getStreamMeta()` for `ctx.complete` / the
 *     partial settle on error (renderResponse returns only frames). The H3 error frame is the Gemini
 *     data-only shape via the NON-sampling `writeSynthetic`. Gemini has no `[DONE]` / no heartbeat.
 *
 * Note: `getStreamMeta().finishReason` is always defined (the terminal default `FINISH_REASON_UNSPECIFIED`),
 * so an error/abort partial that fails BEFORE any upstream finish_reason now records that default
 * `stop_reason` where the legacy handler omitted it — a history-only, failed-request edge field.
 */
async function pumpGeminiStreamingV4(opts: PumpGeminiStreamingV4Options): Promise<void> {
  const { stream, driver, codec, upstream, env } = opts
  const model = (env.body as ChatCompletionsPayload).model
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()

  const sink = makeSseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    forwardedType: () => "generateContent",
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // The driver drives codec.renderResponse (CC→Gemini per-frame) + writes the Gemini frames to the sink.
  const outcome = await driver.runResponseSink(upstream, env, sink)

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[gemini:v4] Client disconnected mid-stream — recording aborted")
    const meta = codec.getStreamMeta()
    env.ctx.abort(model, { usage: geminiUsageFromMeta(meta), ...(meta.finishReason !== undefined && { stop_reason: meta.finishReason }) })
    return
  }

  if (outcome.kind === "stream-error") {
    recordForwarded()
    const error = outcome.error
    const meta = codec.getStreamMeta()
    env.ctx.fail(model, error, { usage: geminiUsageFromMeta(meta), ...(meta.finishReason !== undefined && { stop_reason: meta.finishReason }) })
    consola.error("[gemini:v4] Stream error:", error)
    // Gemini-shape data-only error frame (SDK clients parse every data: frame). NOT forward-sampled
    // (legacy never pushed it) → writeSynthetic.
    const message = error instanceof Error ? error.message : String(error)
    const errorKind = classifyStreamError(error)
    const errorCode = errorKind === "shutdown" ? 503 : 500
    await sink.writeSynthetic?.({
      data: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
        error: { code: errorCode, message, status: geminiStreamErrorStatus(errorKind) },
      }),
    })
    return
  }

  // outcome.kind === "complete" — settle from the codec-accumulated meta. But first detect
  // truncation: a complete Gemini stream carries a real finishReason (its source CC stream always
  // ends with finish_reason → accumulated into the meta DURING streaming). `getStreamMeta()`
  // defaults to FINISH_REASON_UNSPECIFIED when none was seen — a truncated upstream. Detect BEFORE
  // the flush: `codec.flushResponse` would otherwise write a terminal frame carrying that misleading
  // UNSPECIFIED finishReason to the client (P-Gem). See docs/spec/upstream-stream-truncation-detection.md.
  const meta = codec.getStreamMeta()
  if (meta.finishReason === "FINISH_REASON_UNSPECIFIED") {
    // Forward any buffered partial content the translator accumulated (e.g. a tool_call whose
    // args arrived before the truncation — Gemini uniquely buffers tool_calls to flush, unlike
    // the delta-streaming formats), but DROP the translator's terminal frame: it carries the
    // misleading UNSPECIFIED finishReason (the error frame below is the real terminator). The
    // terminal is the only flushed frame with `candidates[0].finishReason`; tool_call frames
    // carry a `functionCall` part and no finishReason. See docs/spec/upstream-stream-truncation-detection.md.
    for (const frame of codec.flushResponse(env)) {
      if (!isGeminiTerminalFrame(frame)) await sink.write(frame)
    }
    recordForwarded()
    const truncErr = new Error("Upstream stream truncated before completion (no finishReason)")
    consola.error(`[gemini:v4] Upstream truncated for ${model}: drained without a real finishReason`)
    env.ctx.fail(model, truncErr, { usage: geminiUsageFromMeta(meta) })
    // Gemini-shape error frame so the client gets a clean terminator. NOT forward-sampled (writeSynthetic).
    await sink.writeSynthetic?.({
      data: JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: truncErr.message }] }, finishReason: "OTHER", index: 0 }],
        error: { code: 500, message: truncErr.message, status: geminiStreamErrorStatus(classifyStreamError(truncErr)) },
      }),
    })
    return
  }

  // drain the translator's stream-end frames (remaining tool calls + the terminal finishReason/usage
  // frame), then settle from the codec-accumulated meta.
  for (const frame of codec.flushResponse(env)) {
    await sink.write(frame)
  }
  recordForwarded()
  env.ctx.complete({
    success: true,
    model,
    usage: geminiUsageFromMeta(meta),
    stop_reason: meta.finishReason,
    content: null,
  })
}

/**
 * Distinguish the translator's terminal flush frame (carries `candidates[0].finishReason`) from a
 * content/tool_call frame (carries a `functionCall`/`text` part, no finishReason). Used by the
 * truncation path to forward buffered partial content while dropping the misleading UNSPECIFIED
 * terminal. A non-JSON / parse-failed frame is treated as non-terminal (forwarded).
 */
function isGeminiTerminalFrame(frame: ClientFrame): boolean {
  if (!frame.data) return false
  try {
    const parsed = JSON.parse(frame.data) as { candidates?: Array<{ finishReason?: unknown }> }
    return parsed.candidates?.[0]?.finishReason !== undefined
  } catch {
    return false
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
