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
 * finishing the codec/driver do NOT: the fallback closing-lifecycle flush (`CandidateResponseSession.renderer.flushResponse`,
 * the CC→Responses translator's stream-end drain — kept handler-side; see
 * docs/archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md for why the "move flush into the driver
 * S6 flush" idea was evaluated and rejected) and session registration (fallback eager pre-stream;
 * direct post-loop via `acc.responseId`). The stateful `fixStreamEventIds` (DIRECT only) runs in the driver's S5
 * response-rewrite registry (A.C), shared with the WS transport. The error frame is built
 * inline (raw upstream message) rather than via `codec.formatError` (P2.2-D4). Responses has
 * no `[DONE]` (it ends with `response.completed`). Failure paths: H2 (a terminal in-band `error`
 * event, tracked as `acc.streamError` — Task 3.2) fails from the accumulator WITHOUT a synthetic
 * frame (the real error frame already reached the client — forwarded live / flushed by the buffered
 * commit); H3 (`stream-error`, a thrown transport failure) and the clean-drain truncation gate each
 * synthesize a client error terminator; plus client-abort.
 */

import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { OpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import type { SseEventRecord } from "~/lib/history/store"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { GhcCompletionTokensDetails } from "~/types/api/ghc-usage"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

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
  createReverseAnthropicMapperHolder,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"
import { HTTPError } from "~/lib/error"
import {
  //
  getSessionIdFromHeaders,
} from "~/lib/history/store"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import { registerResponseSession } from "~/lib/openai/response-session-store"
import { responsesOutputToContent } from "~/lib/openai/responses-conversion"
import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"
import { restoreResponsesOutputToolNames } from "~/lib/openai/tool-name-sanitize"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { createRuntimeHedgePolicy } from "~/lib/pipeline/generation/runtime-policy"
import {
  //
  anthropicNonStreamingTruncation,
  responsesNonStreamingTruncation,
} from "~/lib/pipeline/non-streaming-completeness"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"
import {
  //
  buildAnthropicResponseData,
  buildResponsesResponseData,
} from "~/lib/request/recording"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"
import {
  //
  resolveBufferedCaps,
  state,
} from "~/lib/state"
import { resolveInboundQuery } from "~/lib/transport/query-forward"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"
import {
  //
  logUpstreamStreamOutcomeError,
  logUpstreamStreamTruncation,
} from "~/lib/upstream-stream-diagnostics"
import {
  //
  mapInputDetails,
  mapOutputDetails,
  nonNegOrUndef,
} from "~/types/api/ghc-usage"

import { resolveResponsesBufferedAndHeartbeat } from "./buffered-config"
import {
  //
  createResponsesCandidateResponseSessionFactory,
  responsesCandidateSnapshot,
} from "./candidate-response-session"

/** Responses has no learning-budget strategy; the value is inert (passed for completeness). */
const MAX_LEARNING_RETRIES = 32

export async function handleResponsesV4(c: Context): Promise<Response> {
  const clientRaw = (c.get("injectedPayload") as ResponsesPayload | undefined) ?? (await c.req.json<ResponsesPayload>())
  const azureModelOverride = c.get("azureModelOverride") as string | undefined

  // Resolve the model HERE (transport idle-timeout, codec setup, reverse mapper holder). The async
  // system-prompt injection (`processResponsesInstructions`) has moved OFF the route into the codec's
  // S1b `translateInbound` (RFC 2026-07-14 §4) so `client.inbound` sees the client-native body. Unlike
  // openai-cc, the Responses parse reads no config-managed state, and the legacy flow only reloaded
  // config when `instructions` were present (processResponsesInstructions early-returns otherwise), so
  // no route-level `applyConfigToState` is added here — translateInbound's own reload (when it runs)
  // preserves the exact legacy behavior.
  const { name: resolvedName, routeOverride } = resolveModelTarget(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const conversationId = getSessionIdFromHeaders(c.req.raw.headers)
  // REVERSE `@messages` leg (Phase 5): shared beta probe + Anthropic mapper holder (INERT on the
  // direct/fallback legs — the reverse rewrite/strategies gate MESSAGES).
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder(resolvedName, selectedModel?.vendor)
  const codec = createOpenAiResponsesCodec({ reverseBetaProbe, reverseMapperHolder })
  const transport = createUpstreamResponsesTransport({
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName),
    ...(conversationId !== undefined && { conversationId }),
  })

  const driver = createPipelineDriver({
    codec,
    transport,
    hedgePolicy: createRuntimeHedgePolicy(resolvedName),
    candidateResponseSessionFactory: createResponsesCandidateResponseSessionFactory("http"),
    // S3 request-rewrites, S5 response-rewrites, and the S4 retry stack all come from the CellAssembly now
    // (C5 — every openai-responses cell is migrated: direct `/responses` + `/chat` fallback + reverse
    // `@messages`). The reverse leg's sanitize rewrite + Anthropic stack + the R1 corner (direct/fallback
    // auto-truncate OFF, maxRetries 1) are assembled by OUTBOUND_LEGS + RETRY_SEMANTICS from env.requestState.
    maxRetries: 1,
    maxLearningRetries: MAX_LEARNING_RETRIES,
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: clientRaw,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      query: resolveInboundQuery(c.req.url),
      preResolved: { name: resolvedName, model: selectedModel, ...(routeOverride && { routeOverride }) },
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
  // D2 diagnostic: per-model effective frame-idle timeout (ctx live post-runRequest).
  env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })
  const viaFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS
  const reverseMessages = env.targetEndpoint === ENDPOINT.MESSAGES

  if (!env.stream) {
    try {
      const resp = driver.runResponseNonStreaming(upstream, env) as ResponsesResponse
      // REVERSE `@messages` leg (Phase 5): the client body is the Responses render, but the OUTBOUND leg
      // recorded is the honest Anthropic upstream (richest-data-flow).
      if (reverseMessages) return renderReverseNonStreamingV4(c, env, resp, upstream.nonStream as AnthropicMessageResponse)
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
    const candidate = responsesCandidateSnapshot(driver, upstream)
    const respId = candidate.kind === "responses" ? candidate.fallbackResponseId : undefined
    if (respId) {
      if (!env.ctx.sessionId) env.ctx.setSessionId(respId)
      registerResponseSession(respId, env.ctx.sessionId)
    }
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => clientAbort.abort())
    // RFC Phase 4: ④ capture proxy→client response headers (set by streamSSE before this callback).
    env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    env.ctx.setClientResponseStatus(c.res.status)
    try {
      // REVERSE `@messages` leg (Phase 5): the upstream is Anthropic — accumulate the raw Anthropic frames
      // for the honest outbound while forwarding the rendered Responses frames (no heartbeat — a Responses
      // client is not Claude Code). The direct/fallback legs keep the existing pump.
      if (reverseMessages) await pumpReverseAnthropicLegV4({ stream, driver, codec, upstream, env, clientAbortSignal: clientAbort.signal })
      else await pumpStreamingV4({ stream, driver, codec, upstream, env, viaFallback, clientAbortSignal: clientAbort.signal })
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
  env.ctx.setForwardedResponse({ content: clientResponse })

  // RFC Phase 4: ④ build the client response first, capture its headers, THEN complete.
  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  // Non-streaming semantic-truncation gate (missing / in_progress status → fail, not silent complete).
  const truncationReason = responsesNonStreamingTruncation(resp.status)
  const responseData = {
    success: !truncationReason,
    model: resp.model,
    // Responses `input_tokens` is the TOTAL prompt incl cached; normalize to the
    // canonical net convention (input_tokens disjoint from cache_read).
    usage: usageFromTotalInput({
      totalInput: resp.usage?.input_tokens ?? 0,
      output: resp.usage?.output_tokens ?? 0,
      cacheRead: resp.usage?.input_tokens_details?.cached_tokens,
      cacheCreation: nonNegOrUndef(resp.usage?.input_tokens_details?.cache_write_tokens),
      reasoning: resp.usage?.output_tokens_details?.reasoning_tokens,
      inputDetails: mapInputDetails(resp.usage?.input_tokens_details),
      outputDetails: mapOutputDetails(resp.usage?.output_tokens_details as GhcCompletionTokensDetails | undefined),
    }),
    stop_reason: resp.status,
    content: responsesOutputToContent(resp.output),
    // G6 (richest-data-flow): persist upstream body into rawBody (responseText →
    // rawBody) so non-streaming rows can re-derive cache_write later. Re-serialized
    // from the parsed pristine `resp` (data-lossless). Spec §6.1 (G6).
    sourceBody: resp,
    responseText: JSON.stringify(resp),
  }
  if (truncationReason) {
    env.ctx.fail(resp.model, new Error(truncationReason), {
      usage: responseData.usage,
      stop_reason: responseData.stop_reason,
      content: responseData.content,
      sourceBody: resp,
    })
  } else {
    env.ctx.complete(responseData)
  }

  env.ctx.finalizeModelOperationDelivery({ clientPayload: clientResponse })
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
  /**
   * The downstream client-disconnect signal (the route's `clientAbort`), threaded into the sink's
   * forward-idle heartbeat so keepalive pings STOP once the client has left (a ping to a dead
   * socket is wasted work + would keep sampling the forwarded track after the client is gone).
   */
  clientAbortSignal?: AbortSignal
}

async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env, viaFallback } = opts
  const model = (env.body as ResponsesPayload).model

  // Forwarded SSE frames — what the client ACTUALLY received (tool-name restored). Filled by
  // the sink's `onForwarded` sampler; the upstream-original track is the driver's (runResponse
  // loop-top samples the raw frames before render). Forward-idle keepalive (Phase 2, spec §4 /
  // R3): during a long reasoning silence the sink injects a synthetic `response.ping` every
  // `heartbeatSec` so Codex's 300s idle clock (and other consumers) never times out; the ping is
  // marked `synthetic:"keepalive"` in the forwarded track (never the upstream track). Reuses the
  // keepalive INTERVAL only — NOT the Anthropic-shaped `streamKeepaliveMode` enum.
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）

  // L2 buffered-retry routing + the forced client keepalive cadence (Task 3.2). `buffered`
  // (opt-in `responsesBufferedRetry`) selects the driver's `runResponseBufferedSink` — the SAME
  // shared primitive the Anthropic pump uses (messages/handler-v4.ts:1050), Responses being its
  // second consumer (driver signatures unchanged, all via opts). `heartbeatSec` is FORCED in
  // buffered mode (commit withholds every real frame until the terminal → long silence would
  // otherwise trip Codex's idle deadline; buffered forces a ping even when the operator left
  // `streamKeepalivePingSec` at 0). See resolveResponsesBufferedAndHeartbeat.
  const { buffered: bufferedConfigured, heartbeatSec } = resolveResponsesBufferedAndHeartbeat()
  // Direct and via-chat fallback now share the same buffered unit: the response processor yields
  // fallback `flushResponse()` closing frames before returning, so output_item.done / response.completed
  // are visible to commit boundaries and `sawMessageStop` instead of living in a handler post-loop bypass.
  const buffered = bufferedConfigured
  const sink = makeDeliverySseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    ...clientFirstRealSinkOpts(env),
    ...(heartbeatSec > 0 && {
      heartbeat: {
        intervalSec: heartbeatSec,
        pingFrame: responsesKeepaliveFrame(),
        ...(opts.clientAbortSignal && { clientAbortSignal: opts.clientAbortSignal }),
      },
    }),
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // L2 buffered path (opt-in) vs live default. Buffered adopts the driver's shared
  // `runResponseBufferedSink`: it buffers every rendered frame and commits the WHOLE generation to
  // the sink ONLY on a clean drain that reached a terminal — retrying a transport-close/truncation
  // up to `retryCap` so the client sees exactly ONE complete generation. Live (default) is the
  // unchanged `runResponseSink` (a mid-stream drop → fail + preserved partial + truncation frame).
  //
  // Step 1 conclusion (upstream-error gate): a Responses TERMINAL `error` event (type "error") is
  // NOT a `response.*` lifecycle terminal, so the accumulator does NOT set `acc.status` for it
  // (only `response.completed/.failed/.incomplete` do — responses-stream-accumulator.ts). It is an
  // upstream DECISION to fail (overload / server_error) delivered as a clean SSE frame — the exact
  // shape of Anthropic's H2. Without a dedicated gate, `sawMessageStop: () => acc.status !== ""`
  // alone would treat it as a transport truncation and wastefully RETRY it (then relabel the real
  // error as "truncated" on exhaustion). So we add `sawUpstreamError: () => acc.streamError !==
  // undefined` (the accumulator records the `error` event into `streamError`, mirroring Anthropic's
  // `acc.streamError`) → the buffered sink COMMITS the error frame and the handler fails via the H2
  // `acc.streamError` branch below (the REAL code/message, no synthetic frame), exactly mirroring the
  // live path — NOT the generic truncation gate.
  const outcome =
    buffered ?
      await driver.runResponseBufferedSink(upstream, env, sink, {
        anchor: undefined, // the empty-text keepalive anchor is Anthropic-only → every driver anchor branch is inert
        // Block-level commit boundary (P2 Task 2, spec §3.1): flush at each output item's
        // `response.output_item.done` (+ the three lifecycle terminals + the in-band upstream `error`
        // frame, spec §5.3 M1) instead of once at the terminal drain. A boundary block committed live
        // closes the retry window (driver `committedAny`) — a later truncation degrades to
        // `partial-degrade` instead of retrying (the committed prefix is already on the wire).
        telemetryVendor: "responses",
        retryCap: resolveBufferedCaps("responses").maxRetries,
        bufferCapBytes: resolveBufferedCaps("responses").bufferCapBytes,
      })
    : await driver.runResponseSink(upstream, env, sink)

  const candidate = responsesCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "responses") throw new Error("[Responses:v4] wrong candidate response session kind")
  const { acc, diag } = candidate

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[Responses:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, {
      usage: usageFromTotalInput({
        totalInput: acc.inputTokens,
        output: acc.outputTokens,
        cacheRead: acc.cachedInputTokens,
        cacheCreation: acc.cacheWriteInputTokens,
        reasoning: acc.reasoningTokens,
        inputDetails: acc.inputDetails,
        outputDetails: acc.outputDetails,
      }),
    })
    sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — write the OpenAI error frame + record it into the forwarded track (the client receives
    // it), THEN settle. Order is load-bearing: writeSynthetic samples the frame, recordForwarded
    // snapshots it, and only then does ctx.fail() freeze inboundResponse (a post-fail snapshot misses it).
    const error = outcome.error
    consola.error("[Responses:v4] Stream error:", error)
    logUpstreamStreamOutcomeError(outcome, {
      model: acc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, error, {
      usage: usageFromTotalInput({
        totalInput: acc.inputTokens,
        output: acc.outputTokens,
        cacheRead: acc.cachedInputTokens,
        cacheCreation: acc.cacheWriteInputTokens,
        reasoning: acc.reasoningTokens,
        inputDetails: acc.inputDetails,
        outputDetails: acc.outputDetails,
      }),
    })
    sink.finalize?.()
    return
  }

  // outcome.kind === "complete" — the upstream drained cleanly.
  if (!viaFallback) {
    // Direct registers the session after the loop with the upstream-reported id.
    if (!env.ctx.sessionId && acc.responseId) env.ctx.setSessionId(acc.responseId)
    registerResponseSession(acc.responseId, env.ctx.sessionId)
  }

  // H2 — a TERMINAL upstream `error` SSE event (Responses `type: "error"`; overload / server_error)
  // reached the client as a real content frame: forwarded live through the sink, OR flushed by the
  // buffered commit (driver.ts:661 `sawUpstreamError`). It drains cleanly (never a thrown error →
  // outcome is `complete`) but sets NO `acc.status` (only response.completed/.failed/.incomplete do),
  // so it must be handled HERE — BEFORE the `acc.status === ""` truncation gate, which would otherwise
  // misfire: it would write a SECOND synthetic error frame (double-terminate the stream) and relabel
  // the REAL cause as "truncated" in history. Fail from the accumulator (the real code/message) with
  // NO synthetic frame — the real error frame is already on the wire. Exactly mirrors the live path
  // and Anthropic's H2 (messages/handler-v4.ts:1146). The forwarded track already holds the real error
  // frame (sink `onForwarded` sampled it on the live write / buffered commit), so snapshot THEN fail.
  if (acc.streamError) {
    const partial = buildResponsesResponseData(acc, model)
    consola.error(`[Responses:v4] Upstream error for ${acc.model || model}: ${acc.streamError.code} — ${acc.streamError.message}`)
    recordForwarded()
    env.ctx.fail(acc.model || model, new Error(`${acc.streamError.code}: ${acc.streamError.message}`), { usage: partial.usage, content: partial.content })
    sink.finalize?.()
    return
  }

  // Truncation: a complete Responses stream ALWAYS carries a terminal `response.completed` /
  // `.incomplete` / `.failed` (all three set `acc.status`). An empty `acc.status` after a clean
  // drain means the upstream truncated before any terminal — settle FAIL (preserving the partial)
  // + emit a Responses error frame so the client gets a clean terminator. Checked AFTER the
  // viaFallback drain (whose synthesized closing lifecycle sets `acc.status`), so a real direct
  // truncation is caught while a normal fallback close is not. (A truncated *underlying CC*
  // stream under fallback still gets a synthesized `response.completed` here — that narrower gap
  // is documented in docs/spec/upstream-stream-truncation-detection.md §3.1/Q2.)
  if (acc.status === "") {
    // Emit a Responses error frame (clean terminator) + record it into the forwarded track, THEN
    // settle FAIL preserving the partial. Order: writeSynthetic → recordForwarded → fail.
    const partial = buildResponsesResponseData(acc, model)
    const truncErr = new Error("Upstream stream truncated before completion (no response.completed)")
    consola.error(`[Responses:v4] Upstream truncated for ${acc.model || model}: drained without a terminal response event`)
    logUpstreamStreamTruncation(truncErr.message, {
      model: acc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, truncErr, { usage: partial.usage, content: partial.content })
    sink.finalize?.()
    return
  }

  recordForwarded()
  env.ctx.complete(buildResponsesResponseData(acc, model))
  sink.finalize?.()
}

// ============================================================================
// REVERSE `@messages` leg (Phase 5) — non-streaming render + streaming pump
// ============================================================================

/**
 * Non-streaming render for a REVERSE `@messages` leg (responses→messages). The client-facing body is the
 * Responses render (`resp`, translated Anthropic→CC→Responses via the reverse-exchange, 疑点 5), tool-name
 * restored; the OUTBOUND leg recorded is the HONEST Anthropic upstream (`anthropicUpstream`), NOT the
 * Responses form (richest-data-flow). Truncation is judged on the Anthropic `stop_reason`.
 */
function renderReverseNonStreamingV4(c: Context, env: RequestEnvelope, resp: ResponsesResponse, anthropicUpstream: AnthropicMessageResponse): Response {
  if (!env.ctx.sessionId && resp.id) env.ctx.setSessionId(resp.id)
  registerResponseSession(resp.id, env.ctx.sessionId)

  const clientResponse = restoreResponsesOutputToolNames(resp, env.ctx.toolNameMapper)
  env.ctx.setForwardedResponse({ content: clientResponse })

  const httpResponse = c.json(clientResponse)
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
  env.ctx.finalizeModelOperationDelivery({ clientPayload: clientResponse })
  return httpResponse
}

interface PumpReverseAnthropicLegOptions {
  stream: SSEStreamingApi
  driver: ReturnType<typeof createPipelineDriver>
  codec: OpenAiResponsesCodec
  upstream: UpstreamStream
  env: RequestEnvelope
  clientAbortSignal?: AbortSignal
}

/**
 * Stream pump for a REVERSE `@messages` leg (responses→messages) — the upstream is an Anthropic SSE stream,
 * the codec's DIRECT single-hop `renderResponse` (RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2,
 * Phase 4 subtask F) translates each Anthropic frame straight to Responses event(s), and the client
 * receives the Responses stream. This handler:
 *   - accumulates the RAW UPSTREAM Anthropic frame into the Anthropic accumulator via `onUpstreamFrame` for
 *     the honest `outboundResponse` (RFC §4.1 / richest-data-flow),
 *   - forwards the rendered Responses frames (tool-name restored) + MUST call `CandidateResponseSession.renderer.flushResponse` (the
 *     reverse translator's Responses `response.completed` terminal — 疑点 7b; without it the client never
 *     gets the terminal),
 *   - has NO heartbeat / anchor (a Responses client is not Claude Code),
 *   - settles from its OWN raw Anthropic accumulator (`classifyReverseAnthropicTerminal(anthropicAcc)`
 *     below — NOT `candidate session renderer meta`, whose declared `AnthropicToCcStreamMeta` shape carries CC-only
 *     `finishReason`/`usage` fields this leg's direct translator does not produce; `getMeta()` here only
 *     supplies `sawMessageStop` honestly): a clean drain WITHOUT `message_stop` is an upstream truncation
 *     (F2), failed with a synthetic Responses error terminator.
 */
async function pumpReverseAnthropicLegV4(opts: PumpReverseAnthropicLegOptions): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const model = (env.body as MessagesPayload).model
  const streamStartMs = Date.now()
  const forwardedSseEvents: Array<SseEventRecord> = []
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）
  const sink = makeDeliverySseSink(stream, { onForwarded: (record) => forwardedSseEvents.push(record), streamStartMs, ...clientFirstRealSinkOpts(env) })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  const outcome = await driver.runResponseSink(upstream, env, sink)
  const candidate = responsesCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "reverse-anthropic") throw new Error("[Responses:v4:reverse] wrong candidate response session kind")
  const { anthropicAcc, diag } = candidate

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[Responses:v4:reverse] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(anthropicAcc.model || model, buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    const error = outcome.error
    consola.error("[Responses:v4:reverse] Stream error:", error)
    logUpstreamStreamOutcomeError(outcome, {
      model: anthropicAcc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: anthropicAcc.inputTokens, outputTokens: anthropicAcc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, error, buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }

  // outcome.kind === "complete" — classify the terminal state via the shared reverse classifier (no
  // drift across the three reverse pumps): terminal upstream error (H2) → truncation (F2) → complete.
  const terminal = classifyReverseAnthropicTerminal(anthropicAcc)
  if (terminal.kind === "upstream-error") {
    // H2 — the reverse translator already forwarded a Responses error frame; settle fail with the REAL
    // cause + honest Anthropic outbound, no second synthetic terminator (mirrors the direct pump gate).
    consola.error(`[Responses:v4:reverse] Upstream error for ${anthropicAcc.model || model}: ${terminal.error.type} — ${terminal.error.message}`)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, new Error(`${terminal.error.type}: ${terminal.error.message}`), buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }
  if (terminal.kind === "truncated") {
    const truncErr = new Error("Upstream Anthropic stream truncated before completion (no message_stop)")
    consola.error(`[Responses:v4:reverse] Upstream truncated for ${anthropicAcc.model || model}: drained without message_stop`)
    logUpstreamStreamTruncation(truncErr.message, {
      model: anthropicAcc.model || model,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: anthropicAcc.inputTokens, outputTokens: anthropicAcc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, truncErr, buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }
  if (terminal.kind === "contentless-refusal") {
    const summary = refusalSummary(extractRefusalDetail(anthropicAcc.stopDetails))
    env.ctx.recordFeature("refusal-passthrough", { category: refusalCategoryForDiagnostics(anthropicAcc.stopDetails) })
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, new Error(summary), buildAnthropicResponseData(anthropicAcc, model), { upstreamSucceeded: true })
    sink.finalize?.()
    return
  }
  // The processor finish boundary already emitted response.completed through restore/onRenderedFrame.
  recordForwarded()
  env.ctx.complete(buildAnthropicResponseData(anthropicAcc, model))
  sink.finalize?.()
}
