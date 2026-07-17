/**
 * WebSocket transport for the Responses API.
 *
 * Accepts WebSocket connections on GET /v1/responses (and /responses).
 * Clients send `{ type: "response.create", response: { model, input, ... } }`
 * and receive streaming events as JSON frames (same data as SSE events).
 *
 * This bridges the WebSocket transport to our existing HTTP pipeline:
 * WebSocket message → extract payload → pipeline → SSE events → WS JSON frames.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Hono } from "hono"
import type {
  //
  UpgradeWebSocket,
  WSContext,
} from "hono/ws"

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"
import { registerResponseSession } from "~/lib/openai/response-session-store"
import {
  //
  ENDPOINT,
} from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  restoreResponsesStreamFrameToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { makeWsSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"
import {
  //
  resolveBufferedCaps,
  state,
} from "~/lib/state"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"
import {
  //
  createUpstreamFrameDiagnostics,
  logUpstreamStreamError,
  logUpstreamStreamTruncation,
} from "~/lib/upstream-stream-diagnostics"

import { resolveResponsesBufferedAndHeartbeat } from "./buffered-config"

// ============================================================================
// Constants
// ============================================================================

/** Terminal event types that signal the end of a response */
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

/**
 * Default client-side WebSocket frame cap (1 MiB) is enforced via
 * `state.maxWsFrameBytes` (config `openai_responses.max_ws_frame_bytes`).
 * 0 means unlimited. See onMessage for enforcement.
 */

/**
 * Client-side idle timeout when `client_ws_keep_open` is true (5 min).
 * Without this, a client that opens the socket, sends one `response.create`,
 * and then walks away would pin a WSContext and file descriptor indefinitely.
 * Mirrors the 5-min idle close on the upstream side.
 */
const CLIENT_KEEP_OPEN_IDLE_MS = 5 * 60_000

// ============================================================================
// Payload extraction
// ============================================================================

/**
 * Extract ResponsesPayload from a response.create WebSocket message.
 *
 * Supports two formats:
 * - OpenAI SDK style: `{ type: "response.create", response: { model, input, ... } }`
 * - Flat style: `{ type: "response.create", model, input, ... }`
 *
 * WebSocket transport always streams, so `stream` is forced to `true`.
 */
function extractPayload(message: unknown): ResponsesPayload | null {
  if (typeof message !== "object" || message === null) return null
  const msg = message as Record<string, unknown>

  if (msg.type !== "response.create") return null

  // OpenAI SDK wraps payload in "response" key
  let payload: Record<string, unknown>
  if (msg.response && typeof msg.response === "object") {
    payload = msg.response as Record<string, unknown>
  } else {
    const { type: _type, ...rest } = msg
    payload = rest
  }

  // WebSocket transport always streams
  payload.stream = true

  if (!payload.model || typeof payload.model !== "string") return null
  if (!payload.input) return null

  return payload as unknown as ResponsesPayload
}

// ============================================================================
// Error helpers
// ============================================================================

/**
 * Send an error frame and close the WebSocket. When `forwarded` is supplied (the driver-loop error
 * branches), the sent frame is ALSO sampled into the forwarded track — it is a proxy→client frame
 * the client receives, so it must land in `inboundResponse.sseEvents` (richest-data-flow). The
 * caller must `recordForwarded()` after this and before `ctx.fail` (fail freezes inboundResponse).
 * Pre-driver rejections omit `forwarded` (no forwarded track exists yet).
 */
function sendErrorAndClose(
  ws: WSContext,
  message: string,
  code?: string,
  forwarded?: {
    events: Array<SseEventRecord>
    streamStartMs: number
    captureGenerationFrame?: (frame: unknown, record: SseEventRecord, syntheticKind?: string) => void
  },
  deliveryCtx?: RequestContext,
): void {
  const data = JSON.stringify({
    type: "error",
    error: { type: code ?? "server_error", message },
  })
  if (forwarded) {
    const record: SseEventRecord = { offsetMs: Date.now() - forwarded.streamStartMs, type: "error", raw: data }
    forwarded.events.push(record)
    forwarded.captureGenerationFrame?.({ data }, record, "synthetic")
  }
  if (deliveryCtx) {
    const record: SseEventRecord = { offsetMs: Date.now() - deliveryCtx.startTime, type: "error", raw: data }
    deliveryCtx.captureForwardedGenerationFrame?.({ data }, record, "synthetic")
    deliveryCtx.setForwardedResponse({ content: JSON.parse(data), sseEvents: [record] })
  }
  try {
    ws.send(data)
  } catch {
    // WebSocket might already be closed
  }
  try {
    // 1011/1013 below are RFC-6455-legal SERVER close codes; Bun's WSContext
    // tolerates them (audit Task 0.1, locked by server-ws-close-code-tolerance
    // test). Do NOT "fix" these to 1000 by analogy with the undici CLIENT fix
    // (upstream-ws-connection.ts) — that runtime is WHATWG-strict, this one is not.
    ws.close(1011, message.slice(0, 123)) // WS close reason max 123 bytes
  } catch {
    // Already closed
  }
  if (deliveryCtx) deliveryCtx.finalizeModelOperationDelivery({ clientPayload: JSON.parse(data) })
}

// ============================================================================
// Core handler
// ============================================================================

// ============================================================================
// Per-socket client-abort registry
// ============================================================================

/**
 * Per-socket in-flight client-abort controller. `handleResponseCreate`
 * registers the controller via `registerClientAbort` before driving the
 * pipeline; the WebSocket route's `onClose` / `onError` fire `abort()` so
 * the upstream fetch / WS sendRequest tears down the moment the client goes
 * away. Without this, an abandoned long response keeps the upstream
 * connection (and the full SSE accumulator + forwardedSseEvents buffer)
 * alive until the upstream naturally completes — exactly the heap-residency
 * pattern blamed for the 4GB OOM observed in the wild.
 *
 * Module-level WeakMap so entries are GC'd with the WSContext; we also call
 * `abort()` explicitly in onClose/onError so the controller fires
 * deterministically rather than waiting for finalization.
 */
const wsClientAborts = new WeakMap<WSContext, AbortController>()
const wsConnectionIds = new WeakMap<object, string>()

function wsConnectionKey(ws: WSContext): object {
  return typeof ws.raw === "object" && ws.raw !== null ? ws.raw : ws
}

function stableWsConnectionId(ws: WSContext): string {
  const key = wsConnectionKey(ws)
  const existing = wsConnectionIds.get(key)
  if (existing !== undefined) return existing
  const created = `wsconn_${crypto.randomUUID()}`
  wsConnectionIds.set(key, created)
  return created
}

function responseCreateId(payload: ResponsesPayload): string {
  return typeof payload.id === "string" && payload.id.length > 0 ? payload.id : `wsresp_${crypto.randomUUID()}`
}

/** Handle a response.create message over WebSocket */
async function handleResponseCreate(ws: WSContext, rawPayload: ResponsesPayload): Promise<void> {
  // Create + register the abort controller BEFORE any await — onClose / onError
  // can fire at any point while we're awaiting downstream work, and a late
  // registration would let an inbound disconnect slip past unobserved (the
  // exact OOM-vector this PR is closing). Registration via WeakMap is cheap,
  // and the controller is harmless if never aborted.
  const clientAbort = new AbortController()
  wsClientAborts.set(ws, clientAbort)

  return handleResponseCreateV4(ws, rawPayload, clientAbort)
}

// ============================================================================
// v4 driver path
// ============================================================================

/**
 * Handle a response.create over WebSocket via the v4 driver — **owns-the-sink** (Stage B
 * Responses-WS cut-over). Reuses the SAME driver as the HTTP handler-v4; the driver writes
 * the rendered frames to a `makeWsSink` (ws.send) instead of streamSSE, returning a control-
 * signal `ResponseOutcome`. This handler does the rendered-frame work through `onRenderedFrame`
 * (accumulate + restore + count; WS counts loop AND closing-drain frames) and supplies a
 * `stopAfterFrame` predicate so the driver stops after a terminal event (response.completed/…)
 * — the direct-path early-stop that never reads past the terminal (legacy WS break). Forwarded
 * sampling is in the sink (`onForwarded`); the H3 error path uses `sendErrorAndClose` (the WS
 * analog of the HTTP `writeSynthetic`, sampled into the forwarded track via its `forwarded` arg) +
 * 1011 close; clean completion closes 1000 unless `clientWebsocketKeepOpen`.
 *
 * Unlike the legacy WS path (direct /responses only, rejecting unsupported models), the driver
 * also routes the Responses→CC fallback, so CC-only / Google models work over WS via fallback.
 * The direct path's `fixStreamEventIds` runs in the driver's S5 response-rewrite registry (A.C —
 * the SAME instance the HTTP pump uses); the fallback drains the codec's closing lifecycle via
 * `flushResponse`. Responses has no `[DONE]` / no H2; the WS sink now runs a forward-idle app-layer
 * keepalive (Task 2.2 / R3.5 — see the sink construction below for the protocol-ping-vs-app-frame decision).
 */
async function handleResponseCreateV4(ws: WSContext, rawPayload: ResponsesPayload, clientAbort: AbortController): Promise<void> {
  const operationIdentity = {
    kind: "responses_ws" as const,
    connectionId: stableWsConnectionId(ws),
    responseCreateId: responseCreateId(rawPayload),
    ...(rawPayload.previous_response_id !== undefined && { previousResponseId: rawPayload.previous_response_id }),
  }
  const requestedModel = rawPayload.model
  const { name: resolvedModel, routeOverride } = resolveModelTarget(requestedModel)
  const selectedModel = state.modelIndex.get(resolvedModel)

  // The system-prompt instructions injection is async + non-idempotent — apply it
  // before the sync codec.parse (the route's pre-step), passing the client raw
  // separately for the history snapshot.
  const wireInstructions = await processResponsesInstructions(rawPayload.instructions, resolvedModel, "openai-responses")
  const wireBody: ResponsesPayload = { ...rawPayload, instructions: wireInstructions }

  const codec = createOpenAiResponsesCodec()
  const transport = createUpstreamResponsesTransport({
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedModel),
  })
  const driver = createPipelineDriver({
    codec,
    transport,
    // S5 response-rewrites + the S4 retry stack come from the CellAssembly now (C5 — the openai-responses
    // direct/fallback cells are migrated; RETRY_SEMANTICS encodes the R1 corner auto-truncate OFF / maxRetries 1).
    maxRetries: 1,
    maxLearningRetries: 32,
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: wireBody,
      originalBodyForHistory: rawPayload,
      headers: new Headers(), // WS transport: no inbound HTTP headers to capture
      method: "WS",
      path: "/v1/responses",
      preResolved: { name: resolvedModel, model: selectedModel, ...(routeOverride && { routeOverride }) },
      operationIdentity,
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    const ctx = codec.getContext()
    if (ctx) {
      ctx.fail(resolvedModel, error)
    }
    wsClientAborts.delete(ws)
    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    sendErrorAndClose(ws, message, streamErrorToOpenAIErrorType(error), undefined, ctx)
    return
  }

  if (!result.ok) {
    const ctx = codec.getContext()
    if (ctx) {
      ctx.fail(resolvedModel, new Error(result.rejection.reason))
    }
    wsClientAborts.delete(ws)
    sendErrorAndClose(ws, result.rejection.reason, "invalid_request_error", undefined, ctx)
    return
  }

  const { upstream, env } = result
  // D2 diagnostic: per-model effective frame-idle timeout (ctx live post-runRequest).
  env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedModel) })
  const viaFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS

  // Fallback registers the session eagerly so a mid-stream follow-up resolves it.
  if (viaFallback) {
    const respId = codec.getFallbackResponseId()
    if (respId) {
      if (!env.ctx.sessionId) env.ctx.setSessionId(respId)
      registerResponseSession(respId, env.ctx.sessionId)
    }
  }

  // `let` (not `const`) so the buffered `onAttemptReset` can rebind a FRESH accumulator between
  // retries — mirrors the HTTP handler's `let acc` (handler-v4.ts:277). A discarded attempt's
  // text/tool-call/usage never leaks into the committed generation's history record.
  let acc = createResponsesStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）
  let eventsReceived = 0

  // Upstream-frame diagnostics (disconnect-log blind-spot fix): the WS leg also emits the disconnect
  // diagnostic on a stream-error now, so observe the RAW upstream frames for real frames/bytes/last-frame.
  // `let` so `onAttemptReset` rebinds a fresh collector per buffered attempt (last-failing-attempt frames).
  let diag = createUpstreamFrameDiagnostics(streamStartMs)
  const onUpstreamFrame = (frame: UpstreamFrame): void => diag.observe(frame as ServerSentEventMessage)

  // The driver-owned WS sink: ws.send write-out + forwarded sampling + a forward-idle keepalive
  // (Phase 2 Task 2.2 / R3.5). EMPIRICAL DECISION — app-layer frame, NOT protocol ping:
  //   - Bun.serve DOES auto-send protocol pings (`websocket.sendPings` defaults true) and keeps its
  //     own 120s socket idle-timeout alive — a TRANSPORT-level keepalive that survives silence.
  //   - BUT a protocol ping surfaces to a standard WS consumer as a (non-standard) `ping` EVENT,
  //     never an application `message` (probed on a 127.0.0.1 Bun.serve loopback; 固化 in
  //     responses-ws-keepalive.unit.test.ts). A Codex-style consumer that resets its idle deadline on
  //     application events/messages is therefore NOT kept alive by the protocol ping — the exact WS
  //     analog of "a bare SSE comment does not reset Codex's SSE idle clock" (Task 2.1, spec §4).
  //   ⟹ the WS path injects the SAME app-layer `responsesKeepaliveFrame()` the SSE path does, every
  //     `streamKeepalivePingSec` of forward silence, marked `synthetic:"keepalive"` in the forwarded
  //     track (never the upstream track). Reuses the keepalive INTERVAL only — not `streamKeepaliveMode`.
  const keepaliveSec = state.streamKeepalivePingSec
  const sink = makeWsSink(ws, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
    ...clientFirstRealSinkOpts(env),
    ...(keepaliveSec > 0 && {
      heartbeat: {
        intervalSec: keepaliveSec,
        pingFrame: responsesKeepaliveFrame(),
        clientAbortSignal: clientAbort.signal, // client disconnect suppresses pings
      },
    }),
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  /**
   * Accumulate one rendered Responses frame + restore function_call names (forwarded-only) + count.
   * Returns the restored `{data}`-only frame (WS frames carry no event line), or `undefined` to skip
   * (empty / unparseable — the legacy loop's `!frame.data` guard + `forwardWsFrame`'s parse-fail
   * early return; neither counted). Shared by the driver loop (via `onRenderedFrame`) AND the
   * fallback closing drain — WS counts BOTH (legacy `forwardWsFrame` ran for loop + drain alike,
   * unlike the HTTP pump which only counted the loop). fix-stream-ids (direct) was already applied
   * in the driver's S5 chain.
   */
  const restoreAccumulateCount = (frame: ClientFrame): ClientFrame | undefined => {
    if (!frame.data) return undefined
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(frame.data) as ResponsesStreamEvent
    } catch {
      consola.debug("[WS] Skipping unparseable SSE event")
      return undefined
    }
    accumulateResponsesStreamEvent(event, acc)
    eventsReceived++
    env.ctx.recordStreamProgress({ eventsIn: eventsReceived })
    return { data: restoreResponsesStreamFrameToolNames(frame.data, event.type, mapper) }
  }

  // Terminal early-stop (driver `stopAfterFrame`): the direct path must not read past
  // response.completed/failed/incomplete/error (legacy WS break — an upstream that emits trailing
  // frames or stalls without closing would otherwise hang to idle-timeout). The fallback's terminal
  // (response.completed) comes from `flushResponse` below, not the loop, so this never fires there.
  // NOTE: `stopAfterFrame` is inert on the BUFFERED path below — only `runResponseSink` (the LIVE
  // branch) reads it; `runResponseBufferedSink` drains the upstream loop to its natural EOF/RST and
  // decides retry-vs-commit from that, not from an early stop. It is passed here only because the
  // fallback branch (`viaFallback`, always LIVE) and the non-buffered branch both need it.
  const isTerminal = (frame: ClientFrame): boolean => {
    if (!frame.data) return false
    try {
      return TERMINAL_EVENTS.has((JSON.parse(frame.data) as ResponsesStreamEvent).type)
    } catch {
      return false
    }
  }

  // P4 Task 1 — terminal-only buffered-retry selrouting (block-level-buffered-retry spec §7.3).
  // Reuses the SAME `responses.buffered_retry` config key the HTTP handlers use, but `commitBoundaries`
  // is DELIBERATELY OMITTED: per `RunBufferedOpts.commitBoundaries`'s doc (types.ts), UNDEFINED means
  // terminal-only — the buffer commits exactly once, at the terminal drain (`sawMessageStop` /
  // `sawUpstreamError`), never mid-generation. WS must NOT reuse the HTTP block-level predicate
  // (`isResponsesCommitBoundary`): that predicate treats `response.output_item.done` (an output ITEM
  // finishing, not the whole response) as a commit boundary, which would commit a block live and close
  // the retry window (`committedAny`) before the response actually reaches a terminal — a drop after
  // `output_item.done` but before `response.completed` would then wrongly degrade to `partial-degrade`
  // instead of retrying, delivering a half generation to the client (P4 Task 1 review finding). WS has
  // no mid-stream block/anchor needs, so terminal-only (byte-identical in spirit to the HTTP handler's
  // pre-block-level whole-response buffered predecessor) is the correct — and only — shape here.
  // `buffered && !viaFallback`: the via-chat-completions fallback synthesizes its terminal lifecycle
  // (output_item.done → response.completed) POST-loop via `codec.flushResponse` (see the `viaFallback`
  // branch below), invisible to the driver's in-loop commit/sawMessageStop gate — same structural root
  // cause as the HTTP handler's fallback exclusion (P2 Task 3 / handler-v4.ts:301-307). Fallback stays LIVE.
  const { buffered: bufferedConfigured } = resolveResponsesBufferedAndHeartbeat()
  const buffered = bufferedConfigured && !viaFallback
  const outcome =
    buffered ?
      await driver.runResponseBufferedSink(upstream, env, sink, {
        onRenderedFrame: restoreAccumulateCount,
        onUpstreamFrame,
        stopAfterFrame: isTerminal,
        // commitBoundaries intentionally OMITTED — see the comment above. Terminal-only: the driver's
        // own `sawMessageStop` gate below is the ONLY commit trigger.
        sawMessageStop: () => acc.status !== "",
        // H2 — a terminal upstream `error` frame (clean drain, no response.completed/.failed/.incomplete).
        // Committing it (rather than retrying as a truncation) lets the handler fail via the REAL
        // `acc.streamError` below, mirroring the HTTP handler.
        sawUpstreamError: () => acc.streamError !== undefined,
        // Distinct vendor dimension from "responses" (HTTP) so WS vs HTTP buffered-retry telemetry is
        // separable in `/api/status.protect_streaming.by_vendor` (P0's counters bag is an open
        // `Record<vendor, stats>` — no allowlist — confirmed by protect-streaming-stats.ts:57 and the
        // pre-existing `responses_ws` vendor label already documented in state.ts:323 / types.ts:460 /
        // buffered-retry-keys.test.ts:105, though this task is its FIRST live producer). Caps still
        // resolve from the SHARED "responses" vendor key (below) — only the telemetry bucket differs.
        telemetryVendor: "responses_ws",
        retryCap: resolveBufferedCaps("responses").maxRetries,
        bufferCapBytes: resolveBufferedCaps("responses").bufferCapBytes,
        onBufferedResolve: (o, retries, meta) => {
          if (o === "success" && retries === 0) return
          recordProtectStreamingOutcome(o, retries, meta)
          env.ctx.recordFeature("protect-streaming-retry", { outcome: o, retries, vendor: meta.vendor })
          consola.debug(`[protect-stream:responses_ws] ${o} for ${acc.model || resolvedModel} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
        },
        // Per-attempt isolation: rebind a FRESH accumulator + zero the progress counter before each
        // re-exchange so a discarded attempt's text/tool-calls/usage/eventsReceived never fold into
        // the committed generation's history record (mirrors handler-v4.ts's onAttemptReset).
        onAttemptReset: () => {
          acc = createResponsesStreamAccumulator()
          eventsReceived = 0
          // MEDIUM-2: anchor the fresh collector at THIS attempt's start (not the original request time) so
          // a zero-frame final attempt reports `silence` relative to the attempt, not the whole request.
          diag = createUpstreamFrameDiagnostics(Date.now())
        },
      })
    : await driver.runResponseSink(upstream, env, sink, { onRenderedFrame: restoreAccumulateCount, onUpstreamFrame, stopAfterFrame: isTerminal })

  if (outcome.kind === "settled-abort") {
    recordForwarded()
    consola.debug("[WS] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || resolvedModel, {
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
    // H3 — send the OpenAI error frame (recorded into the forwarded track via sendErrorAndClose's
    // `forwarded` sampler) + close (1011), THEN snapshot + settle. Order is load-bearing:
    // sample → recordForwarded → ctx.fail (fail freezes inboundResponse, so a post-fail snapshot misses it).
    const error = outcome.error
    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    logUpstreamStreamError(error, {
      model: acc.model || resolvedModel,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    sendErrorAndClose(ws, message, streamErrorToOpenAIErrorType(error), {
      events: forwardedSseEvents,
      streamStartMs,
      captureGenerationFrame: (frame, record, syntheticKind) => env.ctx.captureForwardedGenerationFrame?.(frame, record, syntheticKind),
    })
    recordForwarded()
    env.ctx.fail(acc.model || resolvedModel, error, {
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

  // outcome.kind === "complete" — the upstream drained cleanly (or stopped at the terminal frame).
  if (viaFallback) {
    // Drain the CC→Responses translator's closing lifecycle (output_text.done … response.completed),
    // counted + forward-sampled like loop frames (WS parity). (Kept handler-side: the "move this into
    // a driver S6 flush" idea was evaluated and rejected — besides the truncation-detection entanglement,
    // the WS sink's error terminator is the transport-coupled `sendErrorAndClose`+1011 (it must CLOSE the
    // socket, which `sink.writeSynthetic` does not), which a uniform driver finalize cannot model. See
    // docs/archive/2606-landed-rfcs/response-pipeline/finalize-stream-redesign.md.)
    for (const closing of codec.flushResponse(env)) {
      const out = restoreAccumulateCount(closing)
      if (out) await sink.write(out)
    }
  } else {
    if (!env.ctx.sessionId && acc.responseId) env.ctx.setSessionId(acc.responseId)
    registerResponseSession(acc.responseId, env.ctx.sessionId)
  }

  // Truncation: a complete Responses stream carries a terminal response event (sets `acc.status`);
  // an empty `acc.status` after the drain means the upstream truncated before any terminal. Mirrors
  // the HTTP handler, but `sink.writeSynthetic` only SENDS the frame — use `sendErrorAndClose` (the WS
  // H3 analog) to emit the error AND close the socket 1011. Checked AFTER the viaFallback drain (whose
  // synthesized `response.completed` sets `acc.status`). See docs/spec/upstream-stream-truncation-detection.md.
  if (acc.status === "") {
    const partial = buildResponsesResponseData(acc, resolvedModel)
    const truncErr = new Error("Upstream stream truncated before completion (no response.completed)")
    consola.error(`[WS] Upstream truncated for ${acc.model || resolvedModel}: drained without a terminal response event`)
    logUpstreamStreamTruncation(truncErr.message, {
      model: acc.model || resolvedModel,
      streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
      acc: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens },
      sseEvents: diag.sseEvents,
    })
    // Emit the error frame (recorded into forwarded) + close, THEN snapshot + settle (sample →
    // recordForwarded → ctx.fail; fail freezes inboundResponse).
    sendErrorAndClose(ws, truncErr.message, streamErrorToOpenAIErrorType(truncErr), {
      events: forwardedSseEvents,
      streamStartMs,
      captureGenerationFrame: (frame, record, syntheticKind) => env.ctx.captureForwardedGenerationFrame?.(frame, record, syntheticKind),
    })
    recordForwarded()
    env.ctx.fail(acc.model || resolvedModel, truncErr, { usage: partial.usage, content: partial.content })
    sink.finalize?.()
    return
  }

  recordForwarded()
  env.ctx.complete(buildResponsesResponseData(acc, resolvedModel))
  sink.finalize?.()

  if (!state.clientWebsocketKeepOpen) ws.close(1000, "done")
}

// ============================================================================
// WebSocket route registration
// ============================================================================

/**
 * Initialize WebSocket routes for the Responses API.
 *
 * Registers GET /v1/responses and GET /responses on the root Hono app
 * with WebSocket upgrade handling. Uses the shared WebSocket adapter
 * to avoid multiple upgrade listeners on the same HTTP server.
 *
 * @param rootApp - The root Hono app instance
 * @param upgradeWs - Shared WebSocket upgrade function from createWebSocketAdapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initResponsesWebSocket(rootApp: Hono, upgradeWs: UpgradeWebSocket<any>): void {
  // Per-socket in-flight tracking. Bun's WS adapter serializes onMessage by
  // awaiting the returned Promise, so this lock is primarily a defense for
  // non-Bun runtimes (e.g. @hono/node-ws) and as a guard against future
  // adapter behavior changes — a misbehaving client firing two
  // `response.create` frames must never race two pipelines on the same socket.
  // WeakMap so entries are GC'd when the socket is collected.
  const inFlight = new WeakMap<WSContext, Promise<void>>()

  /**
   * Live connection counter for `state.maxClientWsConnections` enforcement.
   * onOpen increments, onClose/onError decrements via `releaseConnection`.
   * `decremented` ensures release is idempotent — onError followed by onClose
   * (or vice versa) must not double-decrement, and a successful onClose alone
   * must still decrement exactly once.
   */
  let liveConnectionCount = 0
  const rejectedAtOpen = new WeakSet<WSContext>()
  const decremented = new WeakSet<WSContext>()

  const releaseConnection = (ws: WSContext) => {
    if (rejectedAtOpen.has(ws)) {
      rejectedAtOpen.delete(ws)
      return
    }
    if (decremented.has(ws)) return
    decremented.add(ws)
    liveConnectionCount = Math.max(0, liveConnectionCount - 1)
  }

  // Per-socket idle timer for keep-open mode. Closes the socket if no new
  // `response.create` arrives within CLIENT_KEEP_OPEN_IDLE_MS. WeakMap so
  // entries are GC'd when the socket is collected; we still clear timers
  // explicitly on close to avoid keeping the runtime alive.
  const idleTimers = new WeakMap<WSContext, ReturnType<typeof setTimeout>>()

  const clearIdleTimer = (ws: WSContext) => {
    const timer = idleTimers.get(ws)
    if (timer) {
      clearTimeout(timer)
      idleTimers.delete(ws)
    }
  }

  const armIdleTimer = (ws: WSContext) => {
    clearIdleTimer(ws)
    if (!state.clientWebsocketKeepOpen) return
    const timer = setTimeout(() => {
      idleTimers.delete(ws)
      try {
        ws.close(1000, "Idle timeout")
      } catch {
        // Already closed
      }
    }, CLIENT_KEEP_OPEN_IDLE_MS)
    // unref so a lingering idle timer never holds the event loop open
    // (e.g. during graceful shutdown or test teardown). Bun/Node both implement
    // this on Timeout; cast through unknown for cross-runtime type compatibility.
    ;(timer as unknown as { unref: () => void }).unref()
    idleTimers.set(ws, timer)
  }

  // Create the WebSocket handler
  const wsHandler = upgradeWs(() => ({
    onOpen(_event: Event, ws: WSContext) {
      // Enforce max client connections BEFORE the connection becomes usable.
      // The cap (state.maxClientWsConnections) is per proxy process; 0 disables.
      const cap = state.maxClientWsConnections
      if (cap > 0 && liveConnectionCount >= cap) {
        rejectedAtOpen.add(ws)
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              error: {
                type: "server_overloaded",
                message: `Server has reached max WebSocket connections (${cap}); retry later`,
              },
            }),
          )
        } catch {
          // Best-effort
        }
        try {
          // 1013 is an RFC-6455-legal SERVER close code Bun tolerates — do NOT
          // rewrite to 1000 by analogy with the undici client fix (see :144).
          ws.close(1013, "Try again later")
        } catch {
          // Already closed
        }
        consola.warn(`[WS] Rejected connection — cap ${cap} reached`)
        return
      }
      liveConnectionCount += 1
      stableWsConnectionId(ws)
      consola.debug(`[WS] Responses API WebSocket connected (active: ${liveConnectionCount})`)
      armIdleTimer(ws)
    },

    onClose(_event: Event, ws: WSContext) {
      releaseConnection(ws)
      consola.debug(`[WS] Responses API WebSocket disconnected (active: ${liveConnectionCount})`)
      clearIdleTimer(ws)
      // Tear down any in-flight upstream work tied to this socket. abort() is
      // idempotent, so a request that already completed (and cleared the
      // WeakMap entry in onMessage.finally) is a no-op here.
      wsClientAborts.get(ws)?.abort()
      wsClientAborts.delete(ws)
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      if (rejectedAtOpen.has(ws)) return
      clearIdleTimer(ws)
      // Parse the incoming message
      let message: unknown
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data)
        // maxWsFrameBytes === 0 means unlimited (operator opt-out); any positive
        // value is the cap. We do not fall back to DEFAULT here — config and
        // state already merge defaults at load time, so by the time we read
        // state, the value is authoritative.
        const cap = state.maxWsFrameBytes
        if (cap > 0 && raw.length > cap) {
          sendErrorAndClose(ws, `Message exceeds ${cap} byte limit (${raw.length} bytes)`, "invalid_request_error")
          return
        }
        message = JSON.parse(raw)
      } catch {
        sendErrorAndClose(ws, "Invalid JSON message", "invalid_request_error")
        return
      }

      // Extract and validate payload
      const payload = extractPayload(message)
      if (!payload) {
        sendErrorAndClose(ws, 'Invalid message: expected { type: "response.create", response: { model, input, ... } }', "invalid_request_error")
        return
      }

      // Reject concurrent response.create on the same socket. Without this,
      // two requests would race on the same WSContext and both write frames.
      if (inFlight.has(ws)) {
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Concurrent response.create not allowed; wait for the previous response to terminate",
              },
            }),
          )
        } catch {
          // Socket may already be gone
        }
        // Re-arm the idle timer — the previous request is still in flight but
        // this rejected frame doesn't count as activity for keep-open purposes.
        armIdleTimer(ws)
        return
      }

      // Handle the response creation, tracking it as in-flight so a follow-up
      // request on the same socket (when keep-open is enabled) is serialized.
      const work = handleResponseCreate(ws, payload).finally(() => {
        inFlight.delete(ws)
        // Request settled normally — drop the abort registration so a later
        // onClose doesn't try to abort an already-finished controller. (abort()
        // is idempotent, but the WeakMap entry would otherwise sit until GC.)
        wsClientAborts.delete(ws)
        // After completion, re-arm the idle timer when keep-open is on. When
        // keep-open is off the socket has already been closed by handleResponseCreate.
        armIdleTimer(ws)
      })
      inFlight.set(ws, work)
      await work
    },

    onError(event: Event, ws: WSContext) {
      consola.error("[WS] Responses API WebSocket error:", event)
      // Release immediately — some adapter error paths don't reliably trigger
      // onClose. releaseConnection is idempotent, so a subsequent onClose is safe.
      releaseConnection(ws)
      clearIdleTimer(ws)
      wsClientAborts.get(ws)?.abort()
      wsClientAborts.delete(ws)
      try {
        // 1011 is an RFC-6455-legal SERVER close code Bun tolerates — do NOT
        // rewrite to 1000 by analogy with the undici client fix (see :144).
        ws.close(1011, "Internal error")
      } catch {
        // Already closed
      }
    },
  }))

  // Register on both paths (GET for WebSocket upgrade, coexists with POST for HTTP)
  rootApp.get("/v1/responses", wsHandler)
  rootApp.get("/responses", wsHandler)

  consola.debug("[WS] Responses API WebSocket routes registered")
}
