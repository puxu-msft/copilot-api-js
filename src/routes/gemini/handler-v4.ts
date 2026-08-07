/**
 * v4 driver path for the Google Gemini endpoints (P2.5).
 *
 * The Gemini route dispatches generateContent / streamGenerateContent here (the
 * v4 driver path — the only path since P3.3 removed the legacy handlers).
 * `countTokens` is NOT a pipeline path (local tokenizer) — it stays on the
 * sibling `handler.ts`.
 *
 * Gemini is a thin translation layer: the route translates Gemini→CC + injects
 * the system-prompt, the {@link createGeminiCodec} delegates the CC-payload
 * S2–S6 to an internal openai-cc codec (incl. the via-responses bridge), and — since
 * Stage B B5 — the codec's `renderResponse` ALSO does the per-frame CC→Gemini render
 * (`createGeminiStreamTranslator`, formerly the handler's whole-stream wrapper), so the
 * owns-the-sink driver writes Gemini frames directly. The streaming handler reads the
 * terminal usage/finishReason out-of-band via `candidate session renderer meta` and drains the
 * stream-end frames via `CandidateResponseSession.renderer.flushResponse`. The non-streaming path still renders
 * CC → Gemini inline (`convertOpenAIResponseToGemini`).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { GeminiCodec } from "~/lib/codec/gemini/codec"
import type { GeminiStreamMeta } from "~/lib/gemini"
import type { SseEventRecord } from "~/lib/history"
import type { UsageData } from "~/lib/history/types"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"
import type {
  //
  GenerateContentRequest,
  GenerateContentResponse,
} from "~/types/api/gemini"
import type {
  //
  GhcCompletionTokensDetails,
  GhcPromptTokensDetails,
} from "~/types/api/ghc-usage"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  extractRefusalDetail,
  isContentlessRefusalResponse,
  refusalCategoryForDiagnostics,
  refusalSummary,
} from "~/lib/anthropic/recover-refusal"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { createGeminiCodec } from "~/lib/codec/gemini/codec"
import {
  //
  createReverseAnthropicMapperHolder,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { HTTPError } from "~/lib/error"
import {
  //
  convertOpenAIResponseToGemini,
} from "~/lib/gemini"
import { geminiStreamErrorFromError } from "~/lib/gemini/stream-error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { createGeminiDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/gemini"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  createCandidateResponseSession,
  type CandidateResponseSession,
  type CandidateResponseSessionFactory,
} from "~/lib/pipeline/generation/candidate-response-session"
import { createRuntimeHedgePolicy } from "~/lib/pipeline/generation/runtime-policy"
import {
  //
  anthropicNonStreamingTruncation,
  openaiNonStreamingTruncation,
} from "~/lib/pipeline/non-streaming-completeness"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"
import { buildAnthropicResponseData } from "~/lib/request/recording"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"
import { state } from "~/lib/state"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"
import { resolveInboundQuery } from "~/lib/transport/query-forward"
import {
  //
  createUpstreamFrameDiagnostics,
  logUpstreamStreamError,
  logUpstreamStreamTruncation,
} from "~/lib/upstream-stream-diagnostics"
import {
  //
  mapInputDetails,
  mapOutputDetails,
  nonNegOrUndef,
} from "~/types/api/ghc-usage"

/** Gemini reuses the CC strategies (network → token-refresh → auto-truncate); no learning budget. */
const MAX_LEARNING_RETRIES = 32

interface GeminiDriverBundle {
  driver: ReturnType<typeof createPipelineDriver>
  codec: ReturnType<typeof createGeminiCodec>
  clientAbort: AbortController
  detachClientAbort: () => void
}

/** Shared driver setup for both Gemini generate paths. */
function buildGeminiDriver(c: Context, modelId: string, resolvedName: string, vendor?: string): GeminiDriverBundle {
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  // REVERSE `@messages` leg (Phase 5): shared beta probe + Anthropic mapper holder (INERT on the
  // direct/via-responses Gemini legs — the reverse rewrite/strategies gate MESSAGES). Threaded into the
  // gemini codec's internal cc delegate so its reverse prepareWire records the outbound Anthropic betas.
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder(resolvedName, vendor)
  const codec = createGeminiCodec(modelId, { reverseBetaProbe, reverseMapperHolder })
  const transport = createUpstreamHttpTransport({ clientAbortSignal: clientAbort.signal, idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })

  const driver = createPipelineDriver({
    codec,
    transport,
    hedgePolicy: createRuntimeHedgePolicy(resolvedName),
    candidateResponseSessionFactory: createGeminiCandidateResponseSession,
    // S3 request-rewrites, S5 response-rewrites, and the S4 retry stack all come from the CellAssembly now
    // (C5 — every Gemini cell is migrated: gemini forward `@cc`/via-responses + the reverse `@messages`
    // cell). The reverse leg's sanitize rewrite + Anthropic stack are assembled by OUTBOUND_LEGS from the
    // shared beta probe + mapper holder the codec threads onto env.requestState.
    maxRetries: state.maxReactiveRetries,
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
  const { name: resolvedName, routeOverride } = resolveModelTarget(modelId)
  const selectedModel = state.modelIndex.get(resolvedName)

  // Gemini→CC translation + async system-prompt injection have moved OFF the route into the gemini
  // codec's S1b `translateInbound` (RFC 2026-07-14 §4), so `client.inbound` (Phase 4) sees the native
  // `contents[]` body. Parse resolves the model (before translateInbound's config reload), and reads
  // no config-managed state on the native body — so no route-level applyConfigToState is needed here.
  const bundle = buildGeminiDriver(c, modelId, resolvedName, selectedModel?.vendor)
  const { driver, codec, clientAbort, detachClientAbort } = bundle

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: geminiBody,
      stream,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      query: resolveInboundQuery(c.req.url),
      preResolved: { name: resolvedName, model: selectedModel, ...(routeOverride && { routeOverride }) },
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

  // D2 diagnostic: per-model effective frame-idle timeout (ctx live post-runRequest).
  result.env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })

  return { bundle, result }
}

/** POST /v1beta/models/:model:generateContent (v4) */
type GeminiCandidateResponseSnapshot =
  | Readonly<{ kind: "gemini"; diag: ReturnType<typeof createUpstreamFrameDiagnostics>; meta: GeminiStreamMeta }>
  | Readonly<{
      kind: "reverse-anthropic"
      anthropicAcc: ReturnType<typeof createAnthropicStreamAccumulator>
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      meta: GeminiStreamMeta
    }>

const createGeminiCandidateResponseSession: CandidateResponseSessionFactory = (input) => {
  const startedAtMs = Date.now()
  if (input.env.targetEndpoint === ENDPOINT.MESSAGES) {
    return createCandidateResponseSession({
      ...input,
      adapter: createGeminiDeliveryProtocolAdapter(),
      createState: () => ({ anthropicAcc: createAnthropicStreamAccumulator(), diag: createUpstreamFrameDiagnostics(startedAtMs) }),
      onUpstreamFrame(state, frame) {
        const raw = frame as ServerSentEventMessage
        state.diag.observe(raw)
        if (!raw.data || raw.data === "[DONE]") return
        try {
          accumulateAnthropicStreamEvent(JSON.parse(raw.data) as never, state.anthropicAcc)
        } catch (error) {
          consola.error("[gemini:v4:reverse] Failed to parse upstream Anthropic stream event:", error, raw.data)
        }
      },
      finish(state, _renderer, rendererFrames) {
        const terminal = classifyReverseAnthropicTerminal(state.anthropicAcc)
        if (terminal.kind === "upstream-error") return { kind: "terminal-failure", frames: [], error: terminal.error }
        if (terminal.kind === "truncated") {
          return {
            kind: "truncated",
            frames: rendererFrames.filter((frame) => !isGeminiTerminalFrame(frame)),
            reason: "Upstream Anthropic stream truncated before completion (no message_stop)",
          }
        }
        return { kind: "complete", frames: rendererFrames }
      },
      snapshot: (state, renderer) => ({ kind: "reverse-anthropic" as const, ...state, meta: renderer.getStreamMeta?.() as GeminiStreamMeta }),
    })
  }

  return createCandidateResponseSession({
    ...input,
    createState: () => ({ diag: createUpstreamFrameDiagnostics(startedAtMs) }),
    onUpstreamFrame: (state, frame) => state.diag.observe(frame as ServerSentEventMessage),
    finish(_state, renderer, rendererFrames) {
      const meta = renderer.getStreamMeta?.() as GeminiStreamMeta
      if (meta.finishReason === "FINISH_REASON_UNSPECIFIED") {
        return {
          kind: "truncated",
          frames: rendererFrames.filter((frame) => !isGeminiTerminalFrame(frame)),
          reason: "Upstream stream truncated before completion (no finishReason)",
        }
      }
      return { kind: "complete", frames: rendererFrames }
    },
    snapshot: (state, renderer) => ({ kind: "gemini" as const, ...state, meta: renderer.getStreamMeta?.() as GeminiStreamMeta }),
  })
}

function geminiCandidateSnapshot(driver: ReturnType<typeof createPipelineDriver>, upstream: UpstreamStream): GeminiCandidateResponseSnapshot {
  const session = driver.getCandidateResponseSession(upstream) as CandidateResponseSession<GeminiCandidateResponseSnapshot> | undefined
  if (!session) throw new Error("[gemini:v4] candidate response session missing")
  return session.snapshot()
}

export async function handleGenerateContentV4(c: Context, modelId: string): Promise<Response> {
  const geminiBody = await c.req.json<GenerateContentRequest>()
  const { bundle, result } = await runGeminiRequest(c, geminiBody, modelId, false)
  const { driver, detachClientAbort } = bundle
  try {
    const ccResp = driver.runResponseNonStreaming(result.upstream, result.env) as ChatCompletionResponse
    // REVERSE `@messages` leg (Phase 5): the client body is CC→Gemini, but the OUTBOUND leg recorded is
    // the honest Anthropic upstream (richest-data-flow).
    if (result.env.targetEndpoint === ENDPOINT.MESSAGES) {
      return renderReverseGeminiNonStreamingV4(c, result.env, ccResp, result.upstream.nonStream as AnthropicMessageResponse, modelId)
    }
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
    result.env.ctx.setClientResponseStatus(c.res.status)
    try {
      // REVERSE `@messages` leg (Phase 5): the upstream is Anthropic — accumulate the raw Anthropic frames
      // for the honest outbound while forwarding the rendered Gemini frames (no heartbeat).
      if (result.env.targetEndpoint === ENDPOINT.MESSAGES)
        await pumpReverseGeminiStreamingV4({ stream, driver, codec, upstream: result.upstream, env: result.env, modelId })
      else await pumpGeminiStreamingV4({ stream, driver, codec, upstream: result.upstream, env: result.env })
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
  env.ctx.setClientResponseStatus(httpResponse.status)

  // Non-streaming semantic-truncation gate (Gemini renders from a CC response → check
  // finish_reason; `.at(0)` so an empty choices array flows through as a fail, not a throw).
  const truncationReason = openaiNonStreamingTruncation(choice?.finish_reason)
  const responseData = {
    success: !truncationReason,
    model: chat.model,
    // Gemini non-streaming renders from a CC response: `usage.prompt_tokens` is the
    // TOTAL prompt incl cached; normalize to the canonical net convention. The Gemini
    // STREAMING path already nets via the codec (convert-response.ts), so this keeps
    // both Gemini legs consistent.
    usage: usageFromTotalInput({
      totalInput: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      cacheRead: usage?.prompt_tokens_details?.cached_tokens,
      cacheCreation: nonNegOrUndef((usage?.prompt_tokens_details as GhcPromptTokensDetails | undefined)?.cache_write_tokens),
      reasoning: usage?.completion_tokens_details?.reasoning_tokens,
      inputDetails: mapInputDetails(usage?.prompt_tokens_details as GhcPromptTokensDetails | undefined),
      outputDetails: mapOutputDetails(usage?.completion_tokens_details as GhcCompletionTokensDetails | undefined),
    }),
    stop_reason: choice?.finish_reason ?? undefined,
    content: choice?.message,
    // G6 (richest-data-flow): persist upstream (CC-shaped) body into rawBody
    // (responseText → rawBody) so non-streaming rows can re-derive cache_write
    // later. Re-serialized from parsed pristine `chat` (data-lossless). Spec §6.1.
    sourceBody: chat,
    responseText: JSON.stringify(chat),
  }
  if (truncationReason) {
    env.ctx.fail(chat.model, new Error(truncationReason), {
      usage: responseData.usage,
      stop_reason: responseData.stop_reason,
      content: responseData.content,
      sourceBody: chat,
    })
  } else {
    env.ctx.complete(responseData)
  }

  env.ctx.finalizeModelOperationDelivery({ clientPayload: gemini })
  return httpResponse
}

// ============================================================================
// Streaming pump (CC → Gemini, whole-stream translator)
// ============================================================================

interface PumpGeminiStreamingV4Options {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0]
  driver: ReturnType<typeof createPipelineDriver>
  codec: GeminiCodec
  upstream: UpstreamStream
  env: RequestEnvelope
}

/** Map the Gemini stream meta (codec-accumulated) → the ctx usage shape (legacy parity). */
function geminiUsageFromMeta(meta: ReturnType<GeminiCodec["getStreamMeta"]>): UsageData {
  // Prefer the canonical UsageData built from the CC accumulator (carries cache_write
  // → cache_creation + modality/prediction details). Fall back to the Gemini-shaped
  // usageMetadata only if the translator produced no canonical usage (defensive).
  if (meta.usage) return meta.usage
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
 *     frame) via `CandidateResponseSession.renderer.flushResponse` after a clean drain (mirrors the Responses fallback flush),
 *   - reads the terminal meta out-of-band via `candidate session renderer meta` for `ctx.complete` / the
 *     partial settle on error (renderResponse returns only frames). The H3 error frame is the Gemini
 *     data-only shape via the NON-sampling `writeSynthetic`. Gemini has no `[DONE]` / no heartbeat.
 *
 * Note: `getStreamMeta().finishReason` is always defined (the terminal default `FINISH_REASON_UNSPECIFIED`),
 * so an error/abort partial that fails BEFORE any upstream finish_reason now records that default
 * `stop_reason` where the legacy handler omitted it — a history-only, failed-request edge field.
 */
async function pumpGeminiStreamingV4(opts: PumpGeminiStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const model = (env.body as ChatCompletionsPayload).model
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）

  const sink = makeDeliverySseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    ...clientFirstRealSinkOpts(env),
    forwardedType: () => "generateContent",
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // The driver drives codec.renderResponse (CC→Gemini per-frame) + writes the Gemini frames to the sink.
  const outcome = await driver.runResponseSink(upstream, env, sink)

  const candidate = geminiCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "gemini") throw new Error("[gemini:v4] wrong candidate response session kind")
  const { diag, meta } = candidate

  if (outcome.kind === "delivery-finished") {
    recordForwarded()
    return
  }
  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[gemini:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(model, { usage: geminiUsageFromMeta(meta), ...(meta.finishReason !== undefined && { stop_reason: meta.finishReason }) })
    await sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    const error = outcome.error
    consola.error("[gemini:v4] Stream error:", error)
    logUpstreamStreamError(error, {
      model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: geminiUsageFromMeta(meta).input_tokens, outputTokens: geminiUsageFromMeta(meta).output_tokens },
      sseEvents: diag.sseEvents,
    })
    // Gemini-shape data-only error frame (SDK clients parse every data: frame). Recorded into the
    // forwarded track (the client receives it) via writeSynthetic → recordForwarded → fail (ordering
    // is load-bearing: ctx.fail freezes inboundResponse, so a post-fail snapshot would miss the frame).
    const message = error instanceof Error ? error.message : String(error)
    await sink
      .writeSynthetic?.({
        data: JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
          error: { ...geminiStreamErrorFromError(error), message },
        }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(model, error, { usage: geminiUsageFromMeta(meta), ...(meta.finishReason !== undefined && { stop_reason: meta.finishReason }) })
    await sink.finalize?.()
    return
  }

  // outcome.kind === "complete" — settle from the codec-accumulated meta. But first detect
  // truncation: a complete Gemini stream carries a real finishReason (its source CC stream always
  // ends with finish_reason → accumulated into the meta DURING streaming). `getStreamMeta()`
  // defaults to FINISH_REASON_UNSPECIFIED when none was seen — a truncated upstream. Detect BEFORE
  // the flush: `CandidateResponseSession.renderer.flushResponse` would otherwise write a terminal frame carrying that misleading
  // UNSPECIFIED finishReason to the client (P-Gem). See docs/spec/upstream-stream-truncation-detection.md.
  if (meta.finishReason === "FINISH_REASON_UNSPECIFIED") {
    // The response processor already forwarded buffered partial tool calls and suppressed the
    // misleading UNSPECIFIED terminal according to `finishResponse` above.
    const truncErr = new Error("Upstream stream truncated before completion (no finishReason)")
    consola.error(`[gemini:v4] Upstream truncated for ${model}: drained without a real finishReason`)
    logUpstreamStreamTruncation(truncErr.message, {
      model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: geminiUsageFromMeta(meta).input_tokens, outputTokens: geminiUsageFromMeta(meta).output_tokens },
      sseEvents: diag.sseEvents,
    })
    // Gemini-shape error frame (clean terminator) recorded into the forwarded track via
    // writeSynthetic → recordForwarded → fail (ctx.fail freezes inboundResponse; a post-fail snapshot misses it).
    await sink
      .writeSynthetic?.({
        data: JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: truncErr.message }] }, finishReason: "OTHER", index: 0 }],
          error: { ...geminiStreamErrorFromError(truncErr), message: truncErr.message },
        }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(model, truncErr, { usage: geminiUsageFromMeta(meta) })
    await sink.finalize?.()
    return
  }

  // Stream-end frames were emitted by the response processor finish boundary.
  recordForwarded()
  env.ctx.complete({
    success: true,
    model,
    usage: geminiUsageFromMeta(meta),
    stop_reason: meta.finishReason,
    content: null,
  })
  await sink.finalize?.()
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

// ============================================================================
// REVERSE `@messages` leg (Phase 5) — non-streaming render + streaming pump
// ============================================================================

/**
 * Non-streaming render for a REVERSE gemini→messages leg. The client body is CC→Gemini (`convertOpenAIResponseToGemini`
 * of the reverse CC render), but the OUTBOUND leg recorded is the HONEST Anthropic upstream
 * (`anthropicUpstream`) — NOT the CC/Gemini form (richest-data-flow). Truncation on the Anthropic stop_reason.
 */
function renderReverseGeminiNonStreamingV4(
  c: Context,
  env: RequestEnvelope,
  chat: ChatCompletionResponse,
  anthropicUpstream: AnthropicMessageResponse,
  modelId: string,
): Response {
  const gemini: GenerateContentResponse = convertOpenAIResponseToGemini(chat, modelId)
  env.ctx.setForwardedResponse({ content: gemini })

  const httpResponse = c.json(gemini)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  const truncationReason = anthropicNonStreamingTruncation(anthropicUpstream.stop_reason)
  const refusalReason = isContentlessRefusalResponse(anthropicUpstream) ? refusalSummary(extractRefusalDetail(anthropicUpstream.stop_details)) : null
  const failureReason = refusalReason ?? truncationReason
  const responseData = {
    success: !failureReason,
    model: anthropicUpstream.model,
    usage: {
      input_tokens: anthropicUpstream.usage.input_tokens,
      output_tokens: anthropicUpstream.usage.output_tokens,
      cache_read_input_tokens: anthropicUpstream.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: anthropicUpstream.usage.cache_creation_input_tokens ?? undefined,
    },
    stop_reason: anthropicUpstream.stop_reason ?? undefined,
    stopDetails: (anthropicUpstream as { stop_details?: unknown }).stop_details,
    content: { role: "assistant" as const, content: anthropicUpstream.content },
    responseText: JSON.stringify(anthropicUpstream),
  }
  if (failureReason) {
    if (refusalReason) env.ctx.recordFeature("refusal-passthrough", { category: refusalCategoryForDiagnostics(anthropicUpstream.stop_details) })
    env.ctx.fail(
      anthropicUpstream.model,
      new Error(failureReason),
      {
        usage: responseData.usage,
        stop_reason: responseData.stop_reason,
        stopDetails: responseData.stopDetails,
        content: responseData.content,
      },
      refusalReason ? { upstreamSucceeded: true } : undefined,
    )
  } else {
    env.ctx.complete(responseData)
  }
  env.ctx.finalizeModelOperationDelivery({ clientPayload: gemini })
  return httpResponse
}

interface PumpReverseGeminiStreamingV4Options {
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0]
  driver: ReturnType<typeof createPipelineDriver>
  codec: GeminiCodec
  upstream: UpstreamStream
  env: RequestEnvelope
  modelId: string
}

/**
 * Stream pump for a REVERSE gemini→messages leg — the upstream is an Anthropic SSE stream, the codec's
 * two-hop `renderResponse` translates each Anthropic frame Anthropic→CC (cc delegate) → Gemini
 * (geminiTranslator), and the client receives the Gemini stream. This handler:
 *   - accumulates the RAW UPSTREAM Anthropic frame into the Anthropic accumulator via `onUpstreamFrame`
 *     for the honest `outboundResponse` (RFC §4.1 / richest-data-flow — the base pumpGeminiStreamingV4 has
 *     NO opts, so the reverse Anthropic track would otherwise never be accumulated, BLOCK 疑点 7a),
 *   - forwards the rendered Gemini frames + MUST call `CandidateResponseSession.renderer.flushResponse` (the geminiTranslator's terminal
 *     finishReason/usage frame — 疑点 7b),
 *   - has NO heartbeat (a Gemini client is not Claude Code),
 *   - detects truncation on the honest Anthropic accumulator's `sawMessageStop` (a clean drain without the
 *     mandatory `message_stop` = upstream truncation, F2): drop the geminiTranslator's terminal frame
 *     (carries the misleading UNSPECIFIED finishReason) + write a Gemini error terminator + fail.
 */
async function pumpReverseGeminiStreamingV4(opts: PumpReverseGeminiStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const model = (env.body as MessagesPayload).model
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）

  const sink = makeDeliverySseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    forwardedType: () => "generateContent",
    ...clientFirstRealSinkOpts(env),
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  const outcome = await driver.runResponseSink(upstream, env, sink)
  const candidate = geminiCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "reverse-anthropic") throw new Error("[gemini:v4:reverse] wrong candidate response session kind")
  const { anthropicAcc, diag } = candidate

  if (outcome.kind === "delivery-finished") {
    recordForwarded()
    return
  }
  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[gemini:v4:reverse] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(anthropicAcc.model || model, buildAnthropicResponseData(anthropicAcc, model))
    await sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    const error = outcome.error
    consola.error("[gemini:v4:reverse] Stream error:", error)
    logUpstreamStreamError(error, {
      model: anthropicAcc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: anthropicAcc.inputTokens, outputTokens: anthropicAcc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    const message = error instanceof Error ? error.message : String(error)
    await sink
      .writeSynthetic?.({
        data: JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
          error: { ...geminiStreamErrorFromError(error), message },
        }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, error, buildAnthropicResponseData(anthropicAcc, model))
    await sink.finalize?.()
    return
  }

  // outcome.kind === "complete" — classify the terminal state via the shared reverse classifier (no
  // drift across the three reverse pumps): a terminal upstream Anthropic `error` frame (H2) wins, else
  // a missing `message_stop` is truncation (F2), else complete.
  const terminal = classifyReverseAnthropicTerminal(anthropicAcc)
  if (terminal.kind === "upstream-error") {
    // H2 — the reverse translator already forwarded a Gemini error frame; settle fail with the REAL
    // cause + honest Anthropic outbound, no second synthetic terminator (mirrors the direct pump gate).
    consola.error(`[gemini:v4:reverse] Upstream error for ${anthropicAcc.model || model}: ${terminal.error.type} — ${terminal.error.message}`)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, new Error(`${terminal.error.type}: ${terminal.error.message}`), buildAnthropicResponseData(anthropicAcc, model))
    await sink.finalize?.()
    return
  }
  // Truncation (F2): a clean drain WITHOUT the mandatory `message_stop`. Drop the geminiTranslator's
  // terminal frame (misleading UNSPECIFIED finishReason) but forward any buffered partial (a tool_call
  // flushed before the cut).
  if (terminal.kind === "truncated") {
    // The processor finish boundary already forwarded partial tool calls and suppressed the
    // misleading Gemini terminal frame.
    const truncErr = new Error("Upstream Anthropic stream truncated before completion (no message_stop)")
    consola.error(`[gemini:v4:reverse] Upstream truncated for ${anthropicAcc.model || model}: drained without message_stop`)
    logUpstreamStreamTruncation(truncErr.message, {
      model: anthropicAcc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: anthropicAcc.inputTokens, outputTokens: anthropicAcc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    await sink
      .writeSynthetic?.({
        data: JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: truncErr.message }] }, finishReason: "OTHER", index: 0 }],
          error: { ...geminiStreamErrorFromError(truncErr), message: truncErr.message },
        }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, truncErr, buildAnthropicResponseData(anthropicAcc, model))
    await sink.finalize?.()
    return
  }
  if (terminal.kind === "contentless-refusal") {
    const summary = refusalSummary(extractRefusalDetail(anthropicAcc.stopDetails))
    env.ctx.recordFeature("refusal-passthrough", { category: refusalCategoryForDiagnostics(anthropicAcc.stopDetails) })
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, new Error(summary), buildAnthropicResponseData(anthropicAcc, model), { upstreamSucceeded: true })
    await sink.finalize?.()
    return
  }

  // The processor finish boundary already emitted the geminiTranslator's stream-end frames.
  recordForwarded()
  env.ctx.complete(buildAnthropicResponseData(anthropicAcc, model))
  await sink.finalize?.()
}
