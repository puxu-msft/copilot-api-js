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

import type { Hono } from "hono"
import type {
  //
  UpgradeWebSocket,
  WSContext,
} from "hono/ws"

import consola from "consola"

import type { HeadersCapture } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type { DriverRequestResult } from "~/lib/pipeline/types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { isV4DriverEnabled } from "~/lib/codec/driver-flags"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses"
import { buildOpenAiResponsesStrategiesForEnv } from "~/lib/codec/openai-responses-strategies"
import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  registerResponseSession,
  resolveResponseSessionId,
} from "~/lib/history/store"
import {
  //
  ENDPOINT,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { responsesInputToMessages } from "~/lib/openai/responses-conversion"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { stripImageGenerationTool } from "~/lib/openai/responses-tool-filter"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  createStreamIdTracker,
  fixStreamEventIds,
} from "~/lib/openai/stream-id-sync"
import {
  //
  RESPONSES_NAME_BEARING_EVENTS,
  restoreResponsesEventToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  guardSseIterable,
  type SseFrame,
} from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

import {
  //
  createResponsesAdapter,
  createResponsesStrategies,
  normalizeCallIds,
} from "./pipeline"

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

/** Send an error frame and close the WebSocket */
function sendErrorAndClose(ws: WSContext, message: string, code?: string): void {
  try {
    ws.send(
      JSON.stringify({
        type: "error",
        error: { type: code ?? "server_error", message },
      }),
    )
  } catch {
    // WebSocket might already be closed
  }
  try {
    ws.close(1011, message.slice(0, 123)) // WS close reason max 123 bytes
  } catch {
    // Already closed
  }
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

/** Handle a response.create message over WebSocket */
async function handleResponseCreate(ws: WSContext, rawPayload: ResponsesPayload): Promise<void> {
  // Create + register the abort controller BEFORE any await — onClose / onError
  // can fire at any point while we're awaiting downstream work, and a late
  // registration would let an inbound disconnect slip past unobserved (the
  // exact OOM-vector this PR is closing). Registration via WeakMap is cheap,
  // and the controller is harmless if never aborted.
  const clientAbort = new AbortController()
  wsClientAborts.set(ws, clientAbort)

  // v4 driver path (behind the `openai-responses` flag): reuse the same driver as
  // the HTTP handler (runRequest/runResponse), with WS frame reads/writes
  // replacing streamSSE. Unlike the legacy WS path (direct /responses only), the
  // driver also supports the Responses→CC fallback — so CC-only / Google models
  // now work over WS via fallback (a consistency improvement; legacy WS sent them
  // to a broken /responses upstream or rejected them).
  if (isV4DriverEnabled("openai-responses")) {
    return handleResponseCreateV4(ws, rawPayload, clientAbort)
  }

  let payload = rawPayload

  const requestedModel = payload.model
  // Snapshot BEFORE any mutation so history "original" reflects the client's
  // raw frame, not the half-processed in-flight version (model resolution,
  // instructions processing, call_id normalization all mutate payload below).
  const originalSnapshot = structuredClone(payload)

  // Strip the image_generation builtin tool when configured — parity with the
  // HTTP handler (Copilot upstream rejects it, failing the whole request).
  // Runs AFTER the snapshot so history retains evidence the client sent it
  // (CLAUDE.md 原则7: 不主动丢弃任何可能有诊断价值的信息).
  stripImageGenerationTool(payload)

  const resolvedModel = resolveModelName(requestedModel)
  payload.model = resolvedModel

  // Check endpoint support
  const selectedModel = state.modelIndex.get(resolvedModel)
  if (!isResponsesSupported(selectedModel)) {
    sendErrorAndClose(ws, `Model "${resolvedModel}" does not support the Responses API`, "invalid_request_error")
    wsClientAborts.delete(ws)
    return
  }

  // Process system prompt (overrides, prepend, append from config)
  payload.instructions = await processResponsesInstructions(payload.instructions, payload.model)

  // Normalize call IDs before pipeline (call_ → fc_)
  if (state.normalizeResponsesCallIds) {
    payload = normalizeCallIds(payload)
  }

  // Create request context for tracking. Per RFC §2.9 the WS entry point
  // passes method="WS" so sinks render the activity line consistently
  // with HTTP routes. ConsoleSink reads ctx via the bus `request.created`
  // event — no separate tuiLogger entry needed (commit 4 deleted lib/tui).
  const reqCtx = getRequestContextManager().create({
    endpoint: "openai-responses",
    sessionId: resolveResponseSessionId(payload.previous_response_id),
    rawPath: "/v1/responses",
    method: "WS",
    path: "/v1/responses",
  })

  reqCtx.setOriginalRequest({
    model: requestedModel,
    messages: responsesInputToMessages(originalSnapshot.input),
    stream: true,
    tools: originalSnapshot.tools,
    system: originalSnapshot.instructions ?? undefined,
    payload: originalSnapshot,
  })
  // WS transport: no inbound HTTP headers to capture

  // Publish resolved model to the observability bus. Always emit so the
  // snapshot's resolvedModel is populated for sinks; include clientModel
  // only on a genuine remap (avoids unnecessary `requested → resolved`
  // arrow when they're the same).
  reqCtx.setResolvedModel({
    resolved: resolvedModel,
    ...(requestedModel !== resolvedModel && { client: requestedModel }),
  })

  // Build pipeline adapter and strategies (shared with HTTP handler)
  const headersCapture: HeadersCapture = {}
  // `clientAbort` was created + registered in `wsClientAborts` at the top of
  // this function — see the comment there. We reuse it here when wiring the
  // adapter so the upstream WS connection sees the same controller the
  // socket-level handlers (onClose / onError) will fire.
  const adapter = createResponsesAdapter(
    selectedModel,
    headersCapture,
    (wireRequest) => {
      reqCtx.setAttemptWireRequest(wireRequest)
    },
    (transport) => {
      reqCtx.setAttemptTransport(transport)
    },
    undefined,
    clientAbort.signal,
  )
  const strategies = createResponsesStrategies()

  // Forwarded frames — what the client actually received over the WebSocket.
  // Hoisted above the try so the catch can still record the partial timeline.
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  // Hoisted so the catch can read partial usage for an aborted record.
  const acc = createResponsesStreamAccumulator()

  try {
    // Execute pipeline (model resolution, token refresh, rate limiting)
    const pipelineResult = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload: payload,
      model: selectedModel,
      maxRetries: 1,
      requestContext: reqCtx,
    })

    // Capture HTTP headers from the final attempt for history recording
    reqCtx.setHttpHeaders(headersCapture)

    const response = pipelineResult.response

    // Stream SSE events → WebSocket JSON frames. `guardSseIterable` owns the
    // stable-signal abort race (so a Phase 3 shutdown is observed even while
    // blocked on a stalled upstream) and the shutdown-vs-client distinction: a
    // shutdown throws StreamShutdownError (→ catch → sendErrorAndClose with a
    // retryable frame), while a client disconnect ends the loop cleanly.
    const idleTimeoutMs = state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0
    const idTracker = state.fixResponsesStreamIds ? createStreamIdTracker() : undefined
    let eventsReceived = 0

    const guarded = guardSseIterable(response as AsyncIterable<SseFrame>, {
      idleTimeoutMs,
      shutdownSignal: getShutdownSignal(),
      clientSignal: clientAbort.signal,
    })

    for await (const sseEvent of guarded) {
      if (!sseEvent.data || sseEvent.data === "[DONE]") continue

      try {
        // Fix inconsistent IDs from upstream before processing
        const eventData = idTracker ? fixStreamEventIds(sseEvent.data, sseEvent.event, idTracker) : sseEvent.data
        const parsed = JSON.parse(eventData) as ResponsesStreamEvent
        accumulateResponsesStreamEvent(parsed, acc)

        // Forward (possibly ID-corrected) event as WebSocket JSON frame
        ws.send(eventData)
        forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: parsed.type, raw: eventData })
        eventsReceived++

        reqCtx.recordStreamProgress({ eventsIn: eventsReceived })

        // Check for terminal events
        if (TERMINAL_EVENTS.has(parsed.type)) break
      } catch {
        consola.debug("[WS] Skipping unparseable SSE event")
      }
    }

    // Record to history
    if (!reqCtx.sessionId && acc.responseId) {
      reqCtx.setSessionId(acc.responseId)
    }
    registerResponseSession(acc.responseId, reqCtx.sessionId)
    const responseData = buildResponsesResponseData(acc, resolvedModel)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    reqCtx.complete(responseData)

    // Close WebSocket unless the client has opted into long-lived sessions.
    // When kept open, the client may send another `response.create` on the same
    // socket; concurrency is rejected by the per-socket in-flight lock below.
    if (!state.clientWebsocketKeepOpen) {
      ws.close(1000, "done")
    }
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })

    // Uniform terminal settle: client disconnect → `aborted` (return, don't
    // send/close the gone socket); else → `fail()` and send an error frame.
    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } }
    if (settleStreamingFailure({ reqCtx, error, model: resolvedModel, partial })) {
      consola.debug("[WS] Client disconnected mid-stream — recording aborted")
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    // Map stream lifecycle errors to the OpenAI error type (idle-timeout →
    // timeout_error, shutdown/other → server_error) for parity with the HTTP
    // Responses path; non-stream errors fall through to server_error.
    sendErrorAndClose(ws, message, streamErrorToOpenAIErrorType(error))
  }
}

// ============================================================================
// v4 driver path
// ============================================================================

/**
 * Handle a response.create over WebSocket via the v4 driver (behind the
 * `openai-responses` flag). Reuses the SAME driver as the HTTP handler-v4 —
 * codec + WS-capable Responses transport + env strategies — and writes the
 * rendered frames as WebSocket JSON frames (ws.send) instead of streamSSE.
 *
 * Unlike the legacy WS path (direct /responses only, rejecting unsupported
 * models), the driver also routes the Responses→CC fallback, so CC-only / Google
 * models work over WS via fallback. The direct path applies `fixStreamEventIds`
 * (handler-side S5, like the HTTP pump); the fallback drains the codec's closing
 * lifecycle via `flushResponse`.
 */
async function handleResponseCreateV4(ws: WSContext, rawPayload: ResponsesPayload, clientAbort: AbortController): Promise<void> {
  const requestedModel = rawPayload.model
  const resolvedModel = resolveModelName(requestedModel)
  const selectedModel = state.modelIndex.get(resolvedModel)

  // The system-prompt instructions injection is async + non-idempotent — apply it
  // before the sync codec.parse (the route's pre-step), passing the client raw
  // separately for the history snapshot.
  const wireInstructions = await processResponsesInstructions(rawPayload.instructions, resolvedModel)
  const wireBody: ResponsesPayload = { ...rawPayload, instructions: wireInstructions }

  const headersCapture: HeadersCapture = {}
  const codec = createOpenAiResponsesCodec()
  const transport = createUpstreamResponsesTransport({
    headersCapture,
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0,
  })
  const driver = createPipelineDriver({
    codec,
    transport,
    strategies: (env) => {
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) env.ctx.recordFeature("via-chat-completions-fallback")
      return buildOpenAiResponsesStrategiesForEnv(env)
    },
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
      preResolved: { name: resolvedModel, model: selectedModel },
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    const ctx = codec.getContext()
    if (ctx) {
      ctx.setHttpHeaders(headersCapture)
      ctx.fail(resolvedModel, error)
    }
    wsClientAborts.delete(ws)
    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    sendErrorAndClose(ws, message, streamErrorToOpenAIErrorType(error))
    return
  }

  if (!result.ok) {
    const ctx = codec.getContext()
    if (ctx) {
      ctx.setHttpHeaders(headersCapture)
      ctx.fail(resolvedModel, new Error(result.rejection.reason))
    }
    wsClientAborts.delete(ws)
    sendErrorAndClose(ws, result.rejection.reason, "invalid_request_error")
    return
  }

  const { upstream, env } = result
  env.ctx.setHttpHeaders(headersCapture)
  const viaFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS

  // Fallback registers the session eagerly so a mid-stream follow-up resolves it.
  if (viaFallback) {
    const respId = codec.getFallbackResponseId()
    if (respId) {
      if (!env.ctx.sessionId) env.ctx.setSessionId(respId)
      registerResponseSession(respId, env.ctx.sessionId)
    }
  }

  const acc = createResponsesStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
  const idTracker = !viaFallback && state.fixResponsesStreamIds ? createStreamIdTracker() : undefined
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let eventsReceived = 0

  /** Forward one rendered Responses frame as a WS JSON frame; returns true on a terminal event. */
  const forwardWsFrame = (rawData: string, rawEvent: string | undefined): boolean => {
    const eventData = idTracker ? fixStreamEventIds(rawData, rawEvent, idTracker) : rawData
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(eventData) as ResponsesStreamEvent
    } catch {
      consola.debug("[WS] Skipping unparseable SSE event")
      return false
    }
    accumulateResponsesStreamEvent(event, acc)
    const forwardData = restoreWsStreamData(eventData, event, mapper)
    ws.send(forwardData)
    forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: event.type, raw: forwardData })
    eventsReceived++
    env.ctx.recordStreamProgress({ eventsIn: eventsReceived })
    return TERMINAL_EVENTS.has(event.type)
  }

  try {
    for await (const frame of driver.runResponse(upstream, env)) {
      if (!frame.data || frame.data === "[DONE]") continue
      // Stop on a terminal event (response.completed/failed/incomplete/error) —
      // parity with the legacy WS loop, which never reads past the terminal frame
      // even if the upstream emits trailing frames or stalls without closing. The
      // fallback's terminal (response.completed) comes from `flushResponse` below,
      // not this loop, so this break only fires on the direct path.
      if (forwardWsFrame(frame.data, frame.event)) break
    }
    // Fallback: drain the CC→Responses closing lifecycle events.
    if (viaFallback) {
      for (const closing of codec.flushResponse(env)) {
        if (closing.data) forwardWsFrame(closing.data, closing.event)
      }
    }

    if (!viaFallback) {
      if (!env.ctx.sessionId && acc.responseId) env.ctx.setSessionId(acc.responseId)
      registerResponseSession(acc.responseId, env.ctx.sessionId)
    }
    const responseData = buildResponsesResponseData(acc, resolvedModel)
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    env.ctx.complete(responseData)

    if (!state.clientWebsocketKeepOpen) ws.close(1000, "done")
  } catch (error) {
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } }
    if (settleStreamingFailure({ reqCtx: env.ctx, error, model: acc.model || resolvedModel, partial })) {
      consola.debug("[WS] Client disconnected mid-stream — recording aborted")
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    sendErrorAndClose(ws, message, streamErrorToOpenAIErrorType(error))
  }
}

/**
 * Restore function_call names (upstream → original) in a Responses SSE data frame
 * for WS forwarding. No-op when `mapper` is null (the default — the legacy WS path
 * did no tool-name handling, so default WS behavior is unchanged).
 */
function restoreWsStreamData(data: string, event: ResponsesStreamEvent, mapper: ToolNameMapper | null): string {
  if (!mapper) return data
  if (!RESPONSES_NAME_BEARING_EVENTS.has(event.type)) return data
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  return restoreResponsesEventToolNames(parsed, mapper) ? JSON.stringify(parsed) : data
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
          ws.close(1013, "Try again later")
        } catch {
          // Already closed
        }
        consola.warn(`[WS] Rejected connection — cap ${cap} reached`)
        return
      }
      liveConnectionCount += 1
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
