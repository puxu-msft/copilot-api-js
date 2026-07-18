/**
 * v4 driver path for Chat Completions (P2.3).
 *
 * The Chat Completions route dispatches here (the v4 driver path — the only path
 * since P3.3 removed the legacy `handleChatCompletion`). Builds a
 * per-request driver (codec + HTTP transport + env strategies) and drives the
 * seven stages, keeping behavior equivalent to the legacy handler.
 *
 * Division of labor (Stage B CC cut-over — owns-the-sink streaming): the DRIVER owns the
 * client write-out (`runResponseSink` writes each rendered frame to a `makeSseSink`); this
 * route does the rendered-frame-side work through the driver's `onRenderedFrame` hook
 * (accumulate + progress + the forwarded-only tool-name restore), samples the forwarded track
 * inside the sink (`onForwarded`), synthesizes the verbose truncation marker + the trailing
 * `[DONE]` (P2.2-D2), and maps the outcome to `complete`/`fail`/`abort`. The H3 error frame is
 * built inline (raw upstream message) rather than via `codec.formatError` (P2.2-D4 — formatError
 * only gets the classified kind; the consumer has the raw error, so it matches legacy).
 * The non-streaming path still renders + settles directly (no sink).
 *
 * P3 (block-level buffered retry, terminal-only): `chatCompletionsBufferedRetry` selects
 * `driver.runResponseBufferedSink` instead of `runResponseSink` — CC has no mid-stream block
 * boundary (deltas carry no structural terminator), so the commit predicate
 * (`ccCommitBoundaries`) is terminal-only: only an in-band upstream `error` frame is a
 * frame-level boundary; the real terminal commit is `sawMessageStop = () => acc.finishReason
 * !== ""`. The handler's post-loop `[DONE]` synthesis stays UNCHANGED and runs after the
 * buffered outcome resolves (the driver drops every upstream `[DONE]`, so `[DONE]` is always
 * handler-synthesized regardless of buffered/live routing).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { SseEventRecord } from "~/lib/history"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type { MessagesPayload } from "~/types/api/anthropic"
import type {
  //
  GhcCompletionTokensDetails,
  GhcPromptTokensDetails,
} from "~/types/api/ghc-usage"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { ccKeepaliveFrame } from "~/lib/codec/openai-cc/keepalive"
import { createReverseAnthropicMapperHolder } from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { applyConfigToState } from "~/lib/config/config"
import { HTTPError } from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import { ccCommitBoundaries } from "~/lib/openai/cc-commit-boundaries"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"
import {
  //
  restoreChatCompletionsChunkToolNames,
  restoreChatCompletionsToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
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
  openaiNonStreamingTruncation,
  anthropicNonStreamingTruncation,
} from "~/lib/pipeline/non-streaming-completeness"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"
import {
  //
  buildAnthropicResponseData,
  buildOpenAIResponseData,
  usageFromTotalInput,
} from "~/lib/request"
import {
  //
  resolveBufferedCaps,
  state,
} from "~/lib/state"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"
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

import { resolveCcBufferedAndHeartbeat } from "./buffered-config"

/** CC has no learning-budget strategy; the value is inert (passed for completeness). */
const MAX_LEARNING_RETRIES = 32

/**
 * Restore tool-call names (upstream → original) in a single CC SSE `data` frame.
 * Best-effort: input unchanged on `[DONE]` / empty / unparseable / no-op / null
 * mapper (a malformed frame never aborts the forward loop). Mirrors the legacy
 * handler's helper byte-for-byte.
 */
function restoreStreamToolNames(data: string | undefined, mapper: ToolNameMapper | null): string {
  if (!mapper || !data || data === "[DONE]") return data ?? ""
  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch {
    return data
  }
  return restoreChatCompletionsChunkToolNames(chunk, mapper) ? JSON.stringify(chunk) : data
}

export async function handleChatCompletionV4(c: Context): Promise<Response> {
  const clientRaw = (c.get("injectedPayload") as ChatCompletionsPayload | undefined) ?? (await c.req.json<ChatCompletionsPayload>())
  const azureModelOverride = c.get("azureModelOverride") as string | undefined

  // Resolve the model HERE (transport idle-timeout, codec setup, reverse mapper holder) and pass it
  // to parse as `preResolved`. The async system-prompt injection (`processOpenAIMessages`) has moved
  // OFF the route into the codec's S1b `translateInbound` (RFC 2026-07-14 §4) so `client.inbound`
  // sees the client-native body; model is still resolved at parse (before translateInbound's config
  // reload), preserving the legacy order.
  const { name: resolvedName, routeOverride } = resolveModelTarget(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)
  // Config freshness is a ROUTE lifecycle concern (distinct from the S1b body injection, which the
  // codec's `translateInbound` owns): `codec.parse` reads config-managed state (e.g.
  // `state.sanitizeToolNames` → the tool-name mapper), so live config.yaml edits must be applied
  // BEFORE parse. The legacy handler got this for free because `processOpenAIMessages` (which awaited
  // `applyConfigToState`) ran at the route pre-parse; now that injection moved to translateInbound
  // (post-parse), the route reloads config explicitly here to preserve parse's config freshness.
  // Model was resolved just above (before the reload) so a `disabled_models` reload can't shift the
  // lookup — matching the legacy order.
  await applyConfigToState()

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  // REVERSE `@messages` leg (Phase 5): the shared beta probe (codec prepareWire recordOutbound +
  // strategies) + the shared Anthropic tool-name mapper holder (sanitize rewrite + resanitize, same
  // source). Both are INERT on the forward/direct CC legs (the reverse rewrite/strategies gate MESSAGES).
  const reverseBetaProbe = createBetaProbe(undefined)
  const reverseMapperHolder = createReverseAnthropicMapperHolder(resolvedName, selectedModel?.vendor)
  const codec = createOpenAiCcCodec({ reverseBetaProbe, reverseMapperHolder })
  const transport = createUpstreamHttpTransport({ clientAbortSignal: clientAbort.signal, idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })

  const driver = createPipelineDriver({
    codec,
    transport,
    hedgePolicy: createRuntimeHedgePolicy(resolvedName),
    candidateResponseSessionFactory: createChatCandidateResponseSession,
    // S3 request-rewrites, S5 response-rewrites, and the S4 retry stack all come from the CellAssembly now
    // (C5 — every CC-client cell is migrated: openai-cc direct/via-responses + the reverse `@messages` cell).
    // The handler no longer supplies them; the reverse leg's sanitize rewrite + Anthropic strategy stack are
    // assembled by `OUTBOUND_LEGS[/v1/messages]` from the shared beta probe + mapper holder the codec threads
    // onto `env.requestState` (constructed above).
    maxRetries: state.maxReactiveRetries,
    maxLearningRetries: MAX_LEARNING_RETRIES,
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: clientRaw,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      preResolved: { name: resolvedName, model: selectedModel, ...(routeOverride && { routeOverride }) },
      ...(azureModelOverride !== undefined && { modelOverride: azureModelOverride }),
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Any failure after parse created the ctx (parse-period sanitize/translate
    // throw, or an exchange failure). Settle it — `codec.getContext()` reaches the
    // ctx even when the throw happened before the envelope was otherwise capturable.
    // (Outbound header legs are written by the driver during the exchange, RFC Phase 2.)
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.fail(resolvedName, error)
    }
    detachClientAbort()
    throw error
  }

  // Expose the ctx on the request so the observability middleware's non-streaming
  // safety net can finalize it from the HTTP status if a path below doesn't settle
  // it (parity with legacy handler.ts c.set("requestContext")).
  const ctx = codec.getContext()
  if (ctx) c.set("requestContext", ctx)

  if (!result.ok) {
    // decideRoute reject — shape the OpenAI 400 (route's forwardError finishes it;
    // the middleware finalizes the now-c.set ctx from the 4xx status).
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

  const { upstream, env } = result

  // D2 diagnostic: record the per-model effective frame-idle timeout for this
  // request (ctx is guaranteed live here — post-runRequest, result.ok). Covers
  // both stream + non-stream paths.
  env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })

  if (!env.stream) {
    try {
      const ccResp = driver.runResponseNonStreaming(upstream, env) as ChatCompletionResponse
      // REVERSE `@messages` leg (Phase 5): the client-facing body is the CC render, but the OUTBOUND leg
      // recorded must be the HONEST Anthropic upstream (richest-data-flow) — a dedicated render path.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return renderReverseNonStreamingV4(c, env, ccResp, upstream.nonStream as AnthropicMessageResponse)
      return renderNonStreamingV4(c, env, ccResp)
    } finally {
      detachClientAbort()
    }
  }

  consola.debug("[ChatCompletions:v4] Streaming response")
  env.ctx.transition("streaming")
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => clientAbort.abort())
    // RFC Phase 4: ④ capture proxy→client response headers (set by streamSSE before this callback).
    env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    env.ctx.setClientResponseStatus(c.res.status)
    try {
      // REVERSE `@messages` leg (Phase 5): the upstream is Anthropic — accumulate the raw Anthropic frames
      // for the honest outbound while forwarding the rendered CC frames (no heartbeat; a CC client is not
      // Claude Code, so no anchor/300s deadline). The forward/direct CC legs keep the byte-critical pump
      // (which owns the terminal-only buffered-retry selrouting + CC keepalive — hence `clientAbortSignal`).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) await pumpReverseAnthropicLegV4({ stream, driver, codec, upstream, env })
      else await pumpStreamingV4({ stream, driver, upstream, env, clientAbortSignal: clientAbort.signal })
    } finally {
      detachClientAbort()
    }
  })
}

type ChatCandidateResponseSnapshot =
  | Readonly<{
      kind: "chat-completions"
      acc: ReturnType<typeof createOpenAIStreamAccumulator>
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      bytesIn: number
      eventsIn: number
    }>
  | Readonly<{
      kind: "reverse-anthropic"
      anthropicAcc: ReturnType<typeof createAnthropicStreamAccumulator>
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      bytesIn: number
      eventsIn: number
    }>

const createChatCandidateResponseSession: CandidateResponseSessionFactory = (input) => {
  const mapper = input.env.ctx.toolNameMapper
  const startedAtMs = Date.now()
  if (input.env.targetEndpoint === ENDPOINT.MESSAGES) {
    return createCandidateResponseSession({
      ...input,
      createState: () => ({
        anthropicAcc: createAnthropicStreamAccumulator(),
        diag: createUpstreamFrameDiagnostics(startedAtMs),
        bytesIn: 0,
        eventsIn: 0,
      }),
      onUpstreamFrame(state, frame) {
        const raw = frame as ServerSentEventMessage
        state.diag.observe(raw)
        if (!raw.data || raw.data === "[DONE]") return
        try {
          accumulateAnthropicStreamEvent(JSON.parse(raw.data) as never, state.anthropicAcc)
        } catch (error) {
          consola.error("[ChatCompletions:v4:reverse] Failed to parse upstream Anthropic stream event:", error, raw.data)
        }
      },
      onRenderedFrame(state, frame) {
        state.bytesIn += frame.data?.length ?? 0
        state.eventsIn++
        input.env.ctx.recordStreamProgress({ bytesIn: state.bytesIn, eventsIn: state.eventsIn })
        return { ...frame, data: restoreStreamToolNames(frame.data, mapper) }
      },
      finish(state, _renderer, rendererFrames) {
        const terminal = classifyReverseAnthropicTerminal(state.anthropicAcc)
        if (terminal.kind === "upstream-error") return { kind: "terminal-failure", frames: [], error: terminal.error }
        if (terminal.kind === "truncated") {
          return { kind: "truncated", frames: rendererFrames, reason: "Upstream Anthropic stream truncated before completion (no message_stop)" }
        }
        return { kind: "complete", frames: rendererFrames }
      },
      snapshot: (state) => ({ kind: "reverse-anthropic" as const, ...state }),
    })
  }

  const requestModel = (input.env.body as ChatCompletionsPayload).model
  return createCandidateResponseSession({
    ...input,
    createState: () => ({
      acc: createOpenAIStreamAccumulator(),
      diag: createUpstreamFrameDiagnostics(startedAtMs),
      bytesIn: 0,
      eventsIn: 0,
    }),
    onUpstreamFrame: (state, frame) => state.diag.observe(frame as ServerSentEventMessage),
    onRenderedFrame(state, frame) {
      state.bytesIn += frame.data?.length ?? 0
      state.eventsIn++
      input.env.ctx.recordStreamProgress({ bytesIn: state.bytesIn, eventsIn: state.eventsIn })
      if (frame.data) {
        try {
          accumulateOpenAIStreamEvent(JSON.parse(frame.data) as ChatCompletionChunk, state.acc)
        } catch (error) {
          consola.debug(
            `[ChatCompletions:v4] skipping unparseable SSE frame (${error instanceof Error ? error.message : String(error)}):`,
            frame.data.slice(0, 200),
          )
        }
      }
      return { ...frame, data: restoreStreamToolNames(frame.data, mapper) }
    },
    sawMessageStop: (state) => state.acc.finishReason !== "",
    sawUpstreamError: (state) => state.acc.streamError !== undefined,
    commitBoundaries: (_state, frame) => ccCommitBoundaries(frame),
    onBufferedResolve(state, outcome, retries, meta) {
      if (outcome === "success" && retries === 0) return
      recordProtectStreamingOutcome(outcome, retries, meta)
      input.env.ctx.recordFeature("protect-streaming-retry", { outcome, retries, vendor: meta.vendor })
      consola.debug(`[protect-stream:chat_completions] ${outcome} for ${state.acc.model || requestModel} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
    },
    snapshot: (state) => ({ kind: "chat-completions" as const, ...state }),
  })
}

function chatCandidateSnapshot(driver: ReturnType<typeof createPipelineDriver>, upstream: UpstreamStream): ChatCandidateResponseSnapshot {
  const session = driver.getCandidateResponseSession(upstream) as CandidateResponseSession<ChatCandidateResponseSnapshot> | undefined
  if (!session) throw new Error("[ChatCompletions:v4] candidate response session missing")
  return session.snapshot()
}

// ============================================================================
// Non-streaming render
// ============================================================================

function renderNonStreamingV4(c: Context, env: RequestEnvelope, originalResponse: ChatCompletionResponse): Response {
  const response = originalResponse

  const choice = response.choices.at(0)
  const usage = response.usage

  // Restore tool_call names (upstream → original) on the client-facing response.
  const clientResponse = restoreChatCompletionsToolNames(response, env.ctx.toolNameMapper)

  env.ctx.setForwardedResponse({ content: clientResponse })
  // RFC Phase 4: ④ build the client response first, capture its headers, THEN complete.
  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  // Non-streaming semantic-truncation gate. `.at(0)` (not `[0]`) so an EMPTY choices
  // array (itself a truncation form) flows through as a missing finish_reason → fail,
  // rather than throwing a TypeError before the gate.
  const truncationReason = openaiNonStreamingTruncation(choice?.finish_reason)
  const responseData = {
    success: !truncationReason,
    model: response.model,
    // `usage.prompt_tokens` is the TOTAL prompt incl cached; normalize to the
    // canonical net convention (input_tokens disjoint from cache_read).
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
    // G6 (richest-data-flow): persist the upstream response body into rawBody
    // (legFromUpstreamResponse maps responseText → rawBody), so non-streaming rows
    // can re-derive cache_write / any usage field later. Re-serialized from the
    // parsed pristine `originalResponse` (transport already discarded the raw text
    // at .json(); a re-serialization is data-lossless — only formatting differs).
    // See docs/spec/2026-07-12-ghc-usage-details.md §6.1 (G6).
    sourceBody: originalResponse,
    responseText: JSON.stringify(originalResponse),
  }
  if (truncationReason) {
    env.ctx.fail(response.model, new Error(truncationReason), {
      usage: responseData.usage,
      stop_reason: responseData.stop_reason,
      content: responseData.content,
      sourceBody: originalResponse,
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
  upstream: UpstreamStream
  env: RequestEnvelope
  /**
   * The downstream client-disconnect signal (the route's `clientAbort`), threaded into the sink's
   * forward-idle heartbeat so keepalive chunks STOP once the client has left (mirrors Responses'
   * `PumpStreamingV4Options.clientAbortSignal`, `routes/responses/handler-v4.ts`).
   */
  clientAbortSignal?: AbortSignal
}

/**
 * Stream pump for the v4 Chat Completions path — **owns-the-sink** (Stage B CC cut-over).
 * The driver OWNS the client write-out: it drives the S5 chain (empty for CC) + S6 render
 * (identity for passthrough, Responses→CC translation for via-responses) and writes each
 * frame to the injected {@link makeSseSink}, returning a control-signal {@link import("~/lib/pipeline/types").ResponseOutcome}.
 * This handler:
 *   - does its rendered-frame-side work in the driver's `onRenderedFrame` hook (the
 *     post-render counterpart of Anthropic's pre-rewrite `onUpstreamFrame`): per frame it
 *     accumulates (UPSTREAM names → the terminal `complete` data), records progress, and
 *     RETURNS the tool-name-RESTORED frame to forward (forwarded-only — the driver's raw
 *     upstream-track sampling keeps the upstream names in history),
 *   - samples the FORWARDED track INSIDE the sink (`onForwarded` → `forwardedSseEvents`):
 *     the verbose marker (written first), every restored content frame, and the synthesized
 *     trailing `[DONE]` all flow through `sink.write` (sampled); the H3 error frame goes
 *     through the NON-sampling `sink.writeSynthetic` (legacy CC never recorded it),
 *   - synthesizes the SINGLE trailing `[DONE]` itself (the driver drops every upstream
 *     `[DONE]`; passthrough AND via-responses both terminate with exactly one — P2.2-D2),
 *   - maps the outcome + its own accumulator to the terminal ctx state. An in-band upstream
 *     `error` frame (H2, `acc.streamError`) is a clean drain WITHOUT `finishReason` — the
 *     buffered path commits it via `sawUpstreamError` (see `ccCommitBoundaries`) instead of
 *     retrying it as a truncation; on BOTH buffered/live it fails via `acc.streamError` below,
 *     mirroring Anthropic/Responses' H2. The remaining failure paths are H3 (`stream-error`) /
 *     client-abort (`settled-abort`).
 *
 * P3 (block-level buffered retry, terminal-only): `resolveCcBufferedAndHeartbeat` selects
 * `driver.runResponseBufferedSink` (terminal-only commit — `ccCommitBoundaries` treats only an
 * in-band upstream `error` frame as a frame-level boundary; the real terminal commit is
 * `sawMessageStop = () => acc.finishReason !== ""`) instead of `runResponseSink`.
 *
 * P3 Task 3 (backlog:316 CC leg): the buffered path withholds ALL real frames until the terminal
 * commit, so a long upstream silence would otherwise trip a CC consumer's idle deadline with zero
 * visible chunks. `resolveCcBufferedAndHeartbeat`'s `heartbeatSec` (FORCED > 0 whenever buffered,
 * regardless of the operator's `streamKeepalivePingSec` setting) is wired into `makeSseSink`'s
 * `heartbeat` option with `ccKeepaliveFrame` as the fixed pingFrame — mirrors Responses'
 * `responsesKeepaliveFrame` wiring (`routes/responses/handler-v4.ts`). The LIVE (non-buffered)
 * branch ALSO heartbeats whenever `streamKeepalivePingSec > 0` — the bundled default is 20
 * (`state.ts`), so CC live streaming emits a keepalive BY DEFAULT, matching the Anthropic/
 * Responses live paths (same `heartbeatSec > 0` gate `resolveCcBufferedAndHeartbeat` resolves
 * either way — buffered forces it on, live just passes the configured value through).
 */
async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const model = (env.body as ChatCompletionsPayload).model

  // Forwarded SSE frames — what the client ACTUALLY received (tool-name restored). Filled by
  // the sink's `onForwarded` sampler; the upstream-original track is the driver's (runResponse
  // loop-top samples the raw frames before render). Forward-idle keepalive (P3 Task 3, backlog:316
  // CC leg): during a long upstream silence the sink injects a synthetic `ccKeepaliveFrame` every
  // `heartbeatSec` so a CC consumer's idle deadline never fires; the chunk is marked
  // `synthetic:"keepalive"` in the forwarded track (never the upstream track).
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()

  // L2 buffered-retry routing + the forced client keepalive cadence (P3 Task 3). `buffered`
  // selects the driver's shared `runResponseBufferedSink` — CC being its third consumer (driver
  // signatures unchanged, all via opts). `heartbeatSec` is FORCED in buffered mode (the buffered
  // commit withholds every real frame until the terminal — long silence would otherwise trip a CC
  // consumer's idle deadline); the live path ALSO heartbeats whenever the operator's
  // `streamKeepalivePingSec > 0` — the bundled default is 20, so CC live streaming heartbeats by
  // default too, matching Anthropic/Responses. See resolveCcBufferedAndHeartbeat.
  const { buffered, heartbeatSec } = resolveCcBufferedAndHeartbeat()

  // The driver-owned client sink: SSE write-out + forwarded sampling. The sink preserves SSE
  // id/retry framing it is given.
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）
  const sink = makeDeliverySseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    ...clientFirstRealSinkOpts(env),
    ...(heartbeatSec > 0 && {
      heartbeat: {
        intervalSec: heartbeatSec,
        // Fixed pingFrame (built once, before any upstream chunk sets `acc.model`) — the request's
        // resolved model (`model`, from the client body) is the best available value at sink
        // construction time; a real upstream chunk's `model` field would be identical for a
        // passthrough exchange in the overwhelming majority of cases.
        pingFrame: ccKeepaliveFrame(model),
        ...(opts.clientAbortSignal && { clientAbortSignal: opts.clientAbortSignal }),
      },
    }),
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // `buffered` (resolved above alongside `heartbeatSec`) selects the driver's shared
  // `runResponseBufferedSink` — the SAME primitive Anthropic/Responses use, CC being its third
  // consumer (driver signatures unchanged, all via opts).
  const outcome =
    buffered ?
      await driver.runResponseBufferedSink(upstream, env, sink, {
        // Block-commit boundary (terminal-only degenerate case, P3 §3.1): CC has no mid-stream
        // block structure, so `ccCommitBoundaries` only recognizes an in-band upstream `error`
        // frame as a frame-level boundary — every content delta returns false. The real terminal
        // commit is `sawMessageStop` below (finish_reason on the last chunk).
        // H2 — a terminal upstream `error` frame (clean drain, no finish_reason). Committing it
        // (rather than retrying as a truncation) lets the handler fail via the REAL `acc.streamError`
        // below, mirroring Anthropic/Responses.
        telemetryVendor: "chat_completions",
        retryCap: resolveBufferedCaps("chat_completions").maxRetries,
        bufferCapBytes: resolveBufferedCaps("chat_completions").bufferCapBytes,
      })
    : await driver.runResponseSink(upstream, env, sink)

  const candidate = chatCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "chat-completions") throw new Error("[ChatCompletions:v4] wrong candidate response session kind")
  const { acc, diag } = candidate

  if (outcome.kind === "settled-abort") {
    // Client disconnected mid-stream — write ZERO further bytes (B0-d). Record what was
    // forwarded so far, then settle as aborted (mirrors settleStreamingFailure's abort branch).
    recordForwarded()
    consola.debug("[ChatCompletions:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, {
      usage: usageFromTotalInput({
        totalInput: acc.inputTokens,
        output: acc.outputTokens,
        cacheRead: acc.cachedTokens,
        cacheCreation: acc.cacheWriteTokens,
        reasoning: acc.reasoningTokens,
        inputDetails: acc.inputDetails,
        outputDetails: acc.outputDetails,
      }),
    })
    sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — the upstream iterable (or a sink write) threw a non-abort error. Write the OpenAI error
    // frame + record it into the forwarded track (the client receives it), THEN settle. Ordering is
    // load-bearing: writeSynthetic samples the frame, recordForwarded snapshots it, and only then does
    // ctx.fail() freeze inboundResponse — a post-fail snapshot would miss the client-received frame.
    const error = outcome.error
    consola.error("[ChatCompletions:v4] Stream error:", error)
    logUpstreamStreamError(error, {
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
        cacheRead: acc.cachedTokens,
        cacheCreation: acc.cacheWriteTokens,
        reasoning: acc.reasoningTokens,
        inputDetails: acc.inputDetails,
        outputDetails: acc.outputDetails,
      }),
    })
    sink.finalize?.()
    return
  }

  // outcome.kind === "complete" — the upstream drained cleanly.
  if (acc.streamError) {
    // H2 — a TERMINAL upstream `error` frame reached the client as a real content frame:
    // forwarded live, OR flushed by the buffered commit (`ccCommitBoundaries` / `sawUpstreamError`).
    // It drains cleanly (never a thrown error → outcome is `complete`) but never carries a
    // finish_reason — must be handled HERE, BEFORE the finish_reason truncation gate below (which
    // would otherwise misfire: a SECOND synthetic error frame double-terminating the stream, and
    // relabeling the REAL cause as "truncated"). Fail from the accumulator (the real code/message)
    // with NO synthetic frame — the real error frame is already on the wire. Mirrors Anthropic's H2
    // (messages/handler-v4.ts) and Responses' H2 (responses/handler-v4.ts).
    const partial = buildOpenAIResponseData(acc, model)
    consola.error(`[ChatCompletions:v4] Upstream error for ${acc.model || model}: ${acc.streamError.type} — ${acc.streamError.message}`)
    recordForwarded()
    env.ctx.fail(acc.model || model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`), { usage: partial.usage, content: partial.content })
    sink.finalize?.()
    return
  }

  // Synthesize the SINGLE trailing `[DONE]` (the driver dropped every upstream one; passthrough +
  // via-responses both terminate with exactly one — P2.2-D2). `sink.write` samples it (type:
  // "message") into the forwarded track before the snapshot. On the buffered path this append
  // happens AFTER the buffered commit resolved (`outcome.kind === "complete"` above already
  // settled the retry loop) — harmless post-commit tail, same client-visible shape as live.
  if (acc.finishReason === "") {
    // Truncation: the rendered stream never carried a finish_reason — a complete OpenAI stream
    // always terminates with one, so a clean drain without it means the upstream truncated
    // mid-stream. Emit an OpenAI error frame instead of the normal `[DONE]` (so the client gets a
    // clean terminator) + record it into the forwarded track, THEN settle FAIL preserving the
    // partial. Order: writeSynthetic → recordForwarded → fail. See docs/spec/upstream-stream-truncation-detection.md.
    const partial = buildOpenAIResponseData(acc, model)
    const truncErr = new Error("Upstream stream truncated before completion (no finish_reason)")
    consola.error(`[ChatCompletions:v4] Upstream truncated for ${acc.model || model}: drained without a finish_reason`)
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
  await sink.write({ data: "[DONE]" })
  recordForwarded()
  env.ctx.complete(buildOpenAIResponseData(acc, model))
  sink.finalize?.()
}

// ============================================================================
// REVERSE `@messages` leg (Phase 5) — non-streaming render + streaming pump
// ============================================================================

/**
 * Non-streaming render for a REVERSE `@messages` leg (cc→messages). The client-facing body is the CC
 * render (`ccResp`, translated Anthropic→CC by the codec), tool-name-restored; the OUTBOUND leg recorded
 * is the HONEST Anthropic upstream (`anthropicUpstream`) — NOT the CC form (richest-data-flow "后端存储
 * 必须完整"). Truncation is judged on the Anthropic `stop_reason` (the honest upstream verdict).
 */
function renderReverseNonStreamingV4(c: Context, env: RequestEnvelope, ccResp: ChatCompletionResponse, anthropicUpstream: AnthropicMessageResponse): Response {
  // Restore client tool_call names on the CC body the client receives.
  const clientResponse = restoreChatCompletionsToolNames(ccResp, env.ctx.toolNameMapper)
  env.ctx.setForwardedResponse({ content: clientResponse })

  // RFC Phase 4: ④ build the client response first, capture its headers, THEN settle.
  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  // The OUTBOUND-leg (honest Anthropic) response data. Truncation gate on the Anthropic stop_reason.
  const truncationReason = anthropicNonStreamingTruncation(anthropicUpstream.stop_reason)
  const responseData = {
    success: !truncationReason,
    model: anthropicUpstream.model,
    usage: {
      input_tokens: anthropicUpstream.usage.input_tokens,
      output_tokens: anthropicUpstream.usage.output_tokens,
      cache_read_input_tokens: anthropicUpstream.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: anthropicUpstream.usage.cache_creation_input_tokens ?? undefined,
    },
    stop_reason: anthropicUpstream.stop_reason ?? undefined,
    content: { role: "assistant" as const, content: anthropicUpstream.content },
    // G6 (richest-data-flow): persist the raw Anthropic upstream body so the outbound row keeps the honest
    // upstream shape (never the CC render). Re-serialized from the parsed pristine response (lossless).
    responseText: JSON.stringify(anthropicUpstream),
  }
  if (truncationReason) {
    env.ctx.fail(anthropicUpstream.model, new Error(truncationReason), {
      usage: responseData.usage,
      stop_reason: responseData.stop_reason,
      content: responseData.content,
    })
  } else {
    env.ctx.complete(responseData)
  }
  env.ctx.finalizeModelOperationDelivery({ clientPayload: clientResponse })
  return httpResponse
}

interface PumpReverseAnthropicLegOptions {
  stream: SSEStreamingApi
  driver: ReturnType<typeof createPipelineDriver>
  codec: ReturnType<typeof createOpenAiCcCodec>
  upstream: UpstreamStream
  env: RequestEnvelope
}

/**
 * Stream pump for a REVERSE `@messages` leg (cc→messages) — the upstream is an Anthropic SSE stream, the
 * codec's `renderResponse` translates each Anthropic frame to CC frame(s) (T5.1), and the client receives
 * the CC stream. This handler:
 *   - accumulates the RAW UPSTREAM Anthropic frame into the Anthropic accumulator via `onUpstreamFrame`, so
 *     `outboundResponse` stays honest (the upstream's real Anthropic shape — RFC §4.1 / richest-data-flow),
 *     distinct from the client track (`inboundResponse.sseEvents` = the forwarded CC frames the sink samples),
 *   - forwards the rendered CC frames (tool-name restored) + synthesizes the SINGLE trailing `[DONE]`,
 *   - has NO heartbeat / anchor (a CC client is not Claude Code — the 300s no-real-content deadline and the
 *     anchor/reconcile three-way do NOT apply; cc/responses/gemini pumps have no heartbeat, WARN-C),
 *   - settles from `candidate session renderer meta` (out-of-band CC finish_reason + net usage): a clean drain WITHOUT
 *     a finish_reason is an upstream truncation (F2 — the Anthropic stream ended with no message_delta / a
 *     missing message_stop), failed with a synthetic OpenAI error terminator.
 *
 * L2 buffered-retry is NOT applied on the reverse leg (RFC §7.3 / OQ6 — the CC client has no equivalent).
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
  const candidate = chatCandidateSnapshot(driver, upstream)
  if (candidate.kind !== "reverse-anthropic") throw new Error("[ChatCompletions:v4:reverse] wrong candidate response session kind")
  const { anthropicAcc, diag } = candidate

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[ChatCompletions:v4:reverse] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(anthropicAcc.model || model, buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — the upstream iterable (or a sink write) threw. Write the CC error frame + record it, THEN settle
    // with the honest Anthropic outbound (order load-bearing: writeSynthetic samples → recordForwarded
    // snapshots → fail freezes inboundResponse).
    const error = outcome.error
    consola.error("[ChatCompletions:v4:reverse] Stream error:", error)
    logUpstreamStreamError(error, {
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

  // outcome.kind === "complete" — the upstream drained cleanly. Classify the terminal state via the
  // shared reverse classifier (so the three reverse pumps cannot drift): a terminal upstream Anthropic
  // `error` frame (H2) wins, else a missing `message_stop` is truncation (F2), else complete.
  const terminal = classifyReverseAnthropicTerminal(anthropicAcc)
  if (terminal.kind === "upstream-error") {
    // H2 — the reverse translator ALREADY forwarded a CC error chunk for this terminal Anthropic error
    // frame, so settle fail with the REAL cause + honest Anthropic outbound; write NO second synthetic
    // terminator (mirrors the direct Anthropic pump's streamError gate). WITHOUT this gate the error
    // frame (no message_stop) misclassifies as truncation and swallows the cause behind "truncated".
    consola.error(`[ChatCompletions:v4:reverse] Upstream error for ${anthropicAcc.model || model}: ${terminal.error.type} — ${terminal.error.message}`)
    recordForwarded()
    env.ctx.fail(anthropicAcc.model || model, new Error(`${terminal.error.type}: ${terminal.error.message}`), buildAnthropicResponseData(anthropicAcc, model))
    sink.finalize?.()
    return
  }
  // The processor finish boundary already emitted reverse translator terminal frames.
  if (terminal.kind === "truncated") {
    const truncErr = new Error("Upstream Anthropic stream truncated before completion (no message_stop)")
    consola.error(`[ChatCompletions:v4:reverse] Upstream truncated for ${anthropicAcc.model || model}: drained without message_stop`)
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
  await sink.write({ data: "[DONE]" })
  recordForwarded()
  env.ctx.complete(buildAnthropicResponseData(anthropicAcc, model))
  sink.finalize?.()
}
