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
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { RESPONSES_RESPONSE_REWRITES } from "~/lib/codec/openai-responses/response-rewrites"
import { buildOpenAiResponsesStrategiesForEnv } from "~/lib/codec/openai-responses/strategies"
import {
  //
  registerResponseSession,
} from "~/lib/history/store"
import {
  //
  ENDPOINT,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
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
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { state } from "~/lib/state"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

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

  return handleResponseCreateV4(ws, rawPayload, clientAbort)
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
 * models work over WS via fallback. The direct path's `fixStreamEventIds` now runs
 * in the driver's S5 response-rewrite registry (A.C — the SAME instance the HTTP
 * pump uses); the fallback drains the codec's closing lifecycle via `flushResponse`.
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
    // S5 — the SAME Responses response-rewrite chain the HTTP handler uses (fix-stream-ids,
    // DIRECT only): registering once makes HTTP + WS share one stateful rewrite instance (A.C).
    responseRewrites: RESPONSES_RESPONSE_REWRITES,
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
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let eventsReceived = 0

  /** Forward one driver-yielded Responses frame as a WS JSON frame; returns true on a terminal event.
   * fix-stream-ids (direct) is applied upstream in the driver's S5 chain, so `rawData` is already fixed. */
  const forwardWsFrame = (rawData: string): boolean => {
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(rawData) as ResponsesStreamEvent
    } catch {
      consola.debug("[WS] Skipping unparseable SSE event")
      return false
    }
    accumulateResponsesStreamEvent(event, acc)
    const forwardData = restoreResponsesStreamFrameToolNames(rawData, event.type, mapper)
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
      if (forwardWsFrame(frame.data)) break
    }
    // Fallback: drain the CC→Responses closing lifecycle events.
    if (viaFallback) {
      for (const closing of codec.flushResponse(env)) {
        if (closing.data) forwardWsFrame(closing.data)
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
