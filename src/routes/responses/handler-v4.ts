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

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { OpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import type { SseEventRecord } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"
import type { MessagesPayload } from "~/types/api/anthropic"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"
import {
  //
  buildReverseResanitize,
  createReverseAnthropicMapperHolder,
  createReverseAnthropicSanitizeRewrite,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { buildOpenAiResponsesStrategiesForEnv } from "~/lib/codec/openai-responses/strategies"
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { assembleStrategiesForEndpoint } from "~/lib/codec/strategy-registry"
import { HTTPError } from "~/lib/error"
import {
  //
  getSessionIdFromHeaders,
  registerResponseSession,
} from "~/lib/history/store"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
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
import { anthropicNonStreamingTruncation, responsesNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import { buildAnthropicResponseData, buildResponsesResponseData } from "~/lib/request/recording"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"
import { state } from "~/lib/state"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { mapInputDetails, mapOutputDetails, nonNegOrUndef } from "~/types/api/ghc-usage"
import type { GhcCompletionTokensDetails } from "~/types/api/ghc-usage"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

import { resolveResponsesBufferedAndHeartbeat } from "./buffered-config"

/** Responses has no learning-budget strategy; the value is inert (passed for completeness). */
const MAX_LEARNING_RETRIES = 32

export async function handleResponsesV4(c: Context): Promise<Response> {
  const clientRaw = (c.get("injectedPayload") as ResponsesPayload | undefined) ?? (await c.req.json<ResponsesPayload>())
  const azureModelOverride = c.get("azureModelOverride") as string | undefined

  // Apply the async, non-idempotent system-prompt injection (instructions) BEFORE
  // the sync codec.parse, passing the client raw separately for the history
  // snapshot. Resolve the model HERE (before processResponsesInstructions' config
  // reload) and pass it as `preResolved` — matching the legacy handler's order.
  const { name: resolvedName, routeOverride } = resolveModelTarget(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)
  const wireInstructions = await processResponsesInstructions(clientRaw.instructions, resolvedName)
  const wireBody: ResponsesPayload = { ...clientRaw, instructions: wireInstructions }

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const conversationId = getSessionIdFromHeaders(c.req.raw.headers)
  // REVERSE `@messages` leg (Phase 5): shared beta probe + Anthropic mapper holder (INERT on the
  // direct/fallback legs — the reverse rewrite/strategies gate MESSAGES).
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder(resolvedName, selectedModel?.vendor)
  const codec = createOpenAiResponsesCodec({ reverseBetaProbe })
  const transport = createUpstreamResponsesTransport({
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: state.streamIdleTimeout * 1000,
    ...(conversationId !== undefined && { conversationId }),
  })

  const driver = createPipelineDriver({
    codec,
    transport,
    // S3 request rewrites: the reverse Anthropic sanitize rewrite gates MESSAGES (inert on the
    // direct/fallback Responses legs).
    requestRewrites: [createReverseAnthropicSanitizeRewrite(reverseMapperHolder)],
    // S5 — the Responses response-rewrite chain (fix-stream-ids, DIRECT only). The driver
    // applies it before render (A.C); the handler forwards the yielded (fixed) frames. Tool-name
    // restore stays handler-side (forwarded-only, post-accumulate, must run on rendered frames).
    // Full-format union (RFC §7.1); on a reverse `@messages` leg the ANTHROPIC册 fires on the upstream
    // Anthropic frames; on the direct/fallback legs it stays fixStreamIds-only / empty.
    responseRewrites: ALL_RESPONSE_REWRITES,
    strategies: (env) => {
      // REVERSE `@messages` leg: the ANTHROPIC strategy stack (outbound wire is Anthropic), supplied from
      // the hub (env.body is the translated + sanitized Anthropic body). resanitize + the sanitize rewrite
      // share ONE mapper holder.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) {
        return assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, {
          anthropic: {
            originalPayload: env.body as MessagesPayload,
            resanitize: buildReverseResanitize(reverseMapperHolder),
            model: env.model as Model | undefined,
            maxRetries: state.autoTruncateMaxRetries,
            betaProbe: reverseBetaProbe,
          },
        })
      }
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
  env.ctx.setForwardedResponse({ content: responsesOutputToContent(clientResponse.output) })

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
    responseText: JSON.stringify(resp),
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
  /**
   * The downstream client-disconnect signal (the route's `clientAbort`), threaded into the sink's
   * forward-idle heartbeat so keepalive pings STOP once the client has left (a ping to a dead
   * socket is wasted work + would keep sampling the forwarded track after the client is gone).
   */
  clientAbortSignal?: AbortSignal
}

async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, codec, upstream, env, viaFallback } = opts
  // `let` (not `const`) so the buffered `onAttemptReset` can rebind a FRESH accumulator between
  // retries: each retry is a new generation, and the closures below (`restoreAndAccumulate` /
  // `onRenderedFrame`) read the CURRENT binding — so a discarded attempt's text/tool-call/usage
  // never leaks into the committed generation's history record (parity with Anthropic's `let acc`).
  let acc = createResponsesStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
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
  let bytesIn = 0
  let eventsIn = 0

  // L2 buffered-retry routing + the forced client keepalive cadence (Task 3.2). `buffered`
  // (opt-in `responsesBufferedRetry`) selects the driver's `runResponseBufferedSink` — the SAME
  // shared primitive the Anthropic pump uses (messages/handler-v4.ts:1050), Responses being its
  // second consumer (driver signatures unchanged, all via opts). `heartbeatSec` is FORCED in
  // buffered mode (commit withholds every real frame until the terminal → long silence would
  // otherwise trip Codex's idle deadline; buffered forces a ping even when the operator left
  // `streamKeepalivePingSec` at 0). See resolveResponsesBufferedAndHeartbeat.
  const { buffered, heartbeatSec } = resolveResponsesBufferedAndHeartbeat()
  const sink = makeSseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    ...(heartbeatSec > 0 && {
      heartbeat: {
        intervalSec: heartbeatSec,
        pingFrame: responsesKeepaliveFrame(),
        ...(opts.clientAbortSignal && { clientAbortSignal: opts.clientAbortSignal }),
      },
    }),
  })
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
        onRenderedFrame, // restore + accumulate (the buffered drain invokes it per frame)
        anchor: undefined, // the empty-text keepalive anchor is Anthropic-only → every driver anchor branch is inert
        sawMessageStop: () => acc.status !== "", // terminal seen (completed/failed/incomplete) = the R5.2 gate, reused from live
        sawUpstreamError: () => acc.streamError !== undefined, // terminal upstream `error` frame → commit + fail (not retry); see above
        // Per-attempt isolation: rebind a FRESH accumulator + zero the progress counters before each
        // re-exchange so a discarded attempt's text/tool-calls/usage/bytes never fold into the committed
        // generation's history record (mirrors Anthropic's onAttemptReset). `forwardedSseEvents` is
        // deliberately NOT reset — the buffered path only writes to the client on commit, so it holds
        // the committed attempt's frames plus any heartbeat pings already on the wire (continuous stream).
        onAttemptReset: () => {
          acc = createResponsesStreamAccumulator()
          bytesIn = 0
          eventsIn = 0
        },
        retryCap: state.protectStreamingMaxRetries,
        bufferCapBytes: state.protectStreamingBufferCapBytes,
        // Hit-rate telemetry parity with Anthropic (messages/handler-v4.ts:1088): counted ONLY for an
        // actual L2 engagement (a save after ≥1 retry, an exhaustion, or a buffer-cap retreat). A clean
        // first-try commit (retries === 0, no RST) is the silent happy path — tagging it would put
        // `protect-streaming-retry` on essentially every buffered 200 and inflate the "success" rate.
        onBufferedResolve: (o, retries) => {
          if (o === "success" && retries === 0) return
          recordProtectStreamingOutcome(o, retries)
          env.ctx.recordFeature("protect-streaming-retry", { outcome: o, retries })
          consola.debug(`[protect-stream:responses] ${o} for ${acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
        },
      })
    : await driver.runResponseSink(upstream, env, sink, { onRenderedFrame })

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[Responses:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, {
      usage: usageFromTotalInput({ totalInput: acc.inputTokens, output: acc.outputTokens, cacheRead: acc.cachedInputTokens, cacheCreation: acc.cacheWriteInputTokens, reasoning: acc.reasoningTokens, inputDetails: acc.inputDetails, outputDetails: acc.outputDetails }),
    })
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — write the OpenAI error frame + record it into the forwarded track (the client receives
    // it), THEN settle. Order is load-bearing: writeSynthetic samples the frame, recordForwarded
    // snapshots it, and only then does ctx.fail() freeze inboundResponse (a post-fail snapshot misses it).
    const error = outcome.error
    consola.error("[Responses:v4] Stream error:", error)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, error, {
      usage: usageFromTotalInput({ totalInput: acc.inputTokens, output: acc.outputTokens, cacheRead: acc.cachedInputTokens, cacheCreation: acc.cacheWriteInputTokens, reasoning: acc.reasoningTokens, inputDetails: acc.inputDetails, outputDetails: acc.outputDetails }),
    })
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
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, truncErr, { usage: partial.usage, content: partial.content })
    return
  }

  recordForwarded()
  env.ctx.complete(buildResponsesResponseData(acc, model))
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
  env.ctx.setForwardedResponse({ content: responsesOutputToContent(clientResponse.output) })

  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  const truncationReason = anthropicNonStreamingTruncation(anthropicUpstream.stop_reason)
  const responseData = {
    success: !truncationReason,
    model: anthropicUpstream.model,
    usage: {
      input_tokens: anthropicUpstream.usage.input_tokens,
      output_tokens: anthropicUpstream.usage.output_tokens,
      ...(anthropicUpstream.usage.cache_read_input_tokens != null && { cache_read_input_tokens: anthropicUpstream.usage.cache_read_input_tokens }),
      ...(anthropicUpstream.usage.cache_creation_input_tokens != null && { cache_creation_input_tokens: anthropicUpstream.usage.cache_creation_input_tokens }),
    },
    stop_reason: anthropicUpstream.stop_reason ?? undefined,
    content: { role: "assistant" as const, content: anthropicUpstream.content },
    responseText: JSON.stringify(anthropicUpstream),
  }
  if (truncationReason) {
    env.ctx.fail(anthropicUpstream.model, new Error(truncationReason), { usage: responseData.usage, stop_reason: responseData.stop_reason, content: responseData.content })
  } else {
    env.ctx.complete(responseData)
  }
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
 * the codec's two-hop `renderResponse` translates each Anthropic frame to Responses event(s), and the client
 * receives the Responses stream. This handler:
 *   - accumulates the RAW UPSTREAM Anthropic frame into the Anthropic accumulator via `onUpstreamFrame` for
 *     the honest `outboundResponse` (RFC §4.1 / richest-data-flow),
 *   - forwards the rendered Responses frames (tool-name restored) + MUST call `codec.flushResponse` (the
 *     reverse translator's Responses `response.completed` terminal — 疑点 7b; without it the client never
 *     gets the terminal),
 *   - has NO heartbeat / anchor (a Responses client is not Claude Code),
 *   - settles from `codec.getStreamMeta()`: a clean drain WITHOUT a finish_reason is an upstream truncation
 *     (F2), failed with a synthetic Responses error terminator.
 */
async function pumpReverseAnthropicLegV4(opts: PumpReverseAnthropicLegOptions): Promise<void> {
  const { stream, driver, codec, upstream, env } = opts
  const model = (env.body as MessagesPayload).model
  const mapper = env.ctx.toolNameMapper

  const anthropicAcc = createAnthropicStreamAccumulator()
  const onUpstreamFrame = (frame: UpstreamFrame): void => {
    const raw = frame as ServerSentEventMessage
    if (!raw.data || raw.data === "[DONE]") return
    try {
      accumulateAnthropicStreamEvent(JSON.parse(raw.data) as never, anthropicAcc)
    } catch (error) {
      consola.error("[Responses:v4:reverse] Failed to parse upstream Anthropic stream event:", error, raw.data)
    }
  }

  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0
  const sink = makeSseSink(stream, { onForwarded: (record) => forwardedSseEvents.push(record), streamStartMs })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // Restore function_call names on the rendered Responses frame (forwarded-only). The ANTHROPIC
  // server-tool-filter already restored on the upstream frames, so this is an idempotent safety net.
  const restore = (frame: ClientFrame): ClientFrame | undefined => {
    if (!frame.data) return undefined
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(frame.data) as ResponsesStreamEvent
    } catch {
      return undefined
    }
    return { event: frame.event ?? event.type, data: restoreResponsesStreamFrameToolNames(frame.data, event.type, mapper) }
  }
  const onRenderedFrame = (frame: ClientFrame): ClientFrame | undefined => {
    if (!frame.data) return undefined
    bytesIn += frame.data.length
    eventsIn++
    env.ctx.recordStreamProgress({ bytesIn, eventsIn })
    return restore(frame)
  }

  const outcome = await driver.runResponseSink(upstream, env, sink, { onUpstreamFrame, onRenderedFrame })

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[Responses:v4:reverse] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(anthropicAcc.model || model, buildAnthropicResponseData(anthropicAcc, model))
    return
  }

  if (outcome.kind === "stream-error") {
    const error = outcome.error
    consola.error("[Responses:v4:reverse] Stream error:", error)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, error, buildAnthropicResponseData(anthropicAcc, model))
    return
  }

  // outcome.kind === "complete" — the CC finish_reason is the F2 signal (undefined ⇒ truncation).
  const meta = codec.getStreamMeta()
  if (meta?.finishReason === undefined) {
    const truncErr = new Error("Upstream Anthropic stream truncated before completion (no finish_reason)")
    consola.error(`[Responses:v4:reverse] Upstream truncated for ${anthropicAcc.model || model}: drained without a finish_reason`)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, truncErr, buildAnthropicResponseData(anthropicAcc, model))
    return
  }
  // Drain the reverse translator's closing lifecycle (response.completed) — the per-frame render has no
  // stream-end hook (疑点 7b). Each closing frame is restored + forwarded (sampled by the sink).
  for (const closing of codec.flushResponse(env)) {
    const out = restore(closing)
    if (out) await sink.write(out)
  }
  recordForwarded()
  env.ctx.complete(buildAnthropicResponseData(anthropicAcc, model))
}
