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
import type { UpgradeWebSocket, WSContext } from "hono/ws"

import consola from "consola"

import type { HeadersCapture } from "~/lib/context/request"
import type { ResponsesPayload, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { getRequestContextManager } from "~/lib/context/manager"
import { ENDPOINT, isEndpointSupported } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { responsesInputToMessages } from "~/lib/openai/responses-conversion"
import {
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { STREAM_ABORTED, raceIteratorNext } from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"

import { createResponsesAdapter, createResponsesStrategies } from "./pipeline"

// ============================================================================
// Constants
// ============================================================================

/** Terminal event types that signal the end of a response */
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

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

/** Handle a response.create message over WebSocket */
async function handleResponseCreate(ws: WSContext, payload: ResponsesPayload): Promise<void> {
  const requestedModel = payload.model
  const resolvedModel = resolveModelName(requestedModel)
  payload.model = resolvedModel

  // Check endpoint support
  const selectedModel = state.modelIndex.get(resolvedModel)
  if (!isEndpointSupported(selectedModel, ENDPOINT.RESPONSES)) {
    sendErrorAndClose(ws, `Model "${resolvedModel}" does not support the Responses API`, "invalid_request_error")
    return
  }

  // Process system prompt (overrides, prepend, append from config)
  payload.instructions = await processResponsesInstructions(payload.instructions, payload.model)

  // TUI logging — use "WS" as method indicator
  const tuiLogId = tuiLogger.startRequest({
    method: "WS",
    path: "/v1/responses",
    model: resolvedModel,
  })

  // Create request context for tracking
  const reqCtx = getRequestContextManager().create({ endpoint: "openai-responses", tuiLogId })

  reqCtx.setOriginalRequest({
    model: requestedModel,
    messages: responsesInputToMessages(payload.input),
    stream: true,
    tools: payload.tools,
    system: payload.instructions ?? undefined,
    payload,
  })

  // Update TUI with resolved model (if different from requested)
  if (requestedModel !== resolvedModel) {
    tuiLogger.updateRequest(tuiLogId, {
      model: resolvedModel,
      clientModel: requestedModel,
    })
  }

  // Build pipeline adapter and strategies (shared with HTTP handler)
  const headersCapture: HeadersCapture = {}
  const adapter = createResponsesAdapter(selectedModel, headersCapture)
  const strategies = createResponsesStrategies()

  try {
    // Execute pipeline (model resolution, token refresh, rate limiting)
    const pipelineResult = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload: payload,
      model: selectedModel,
      maxRetries: 1,
    })

    // Capture HTTP headers from the final attempt for history recording
    reqCtx.setHttpHeaders(headersCapture)

    const response = pipelineResult.response

    // Stream SSE events → WebSocket JSON frames
    // The pipeline returns an AsyncIterable<ServerSentEventMessage> for streaming
    const iterator = (response as AsyncIterable<{ data?: string; event?: string }>)[Symbol.asyncIterator]()
    const acc = createResponsesStreamAccumulator()
    const idleTimeoutMs = state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0
    const shutdownSignal = getShutdownSignal()
    let eventsReceived = 0

    while (true) {
      const result = await raceIteratorNext(iterator.next(), {
        idleTimeoutMs,
        abortSignal: shutdownSignal ?? undefined,
      })

      if (result === STREAM_ABORTED || result.done) break

      const sseEvent = result.value
      if (!sseEvent.data || sseEvent.data === "[DONE]") continue

      try {
        const parsed = JSON.parse(sseEvent.data) as ResponsesStreamEvent
        accumulateResponsesStreamEvent(parsed, acc)

        // Forward event as WebSocket JSON frame
        ws.send(sseEvent.data)
        eventsReceived++

        // Update TUI with stream progress
        tuiLogger.updateRequest(tuiLogId, { streamEventsIn: eventsReceived })

        // Check for terminal events
        if (TERMINAL_EVENTS.has(parsed.type)) break
      } catch {
        consola.debug("[WS] Skipping unparseable SSE event")
      }
    }

    // Record to history
    const responseData = buildResponsesResponseData(acc, resolvedModel)
    reqCtx.complete(responseData)

    // Close WebSocket gracefully
    ws.close(1000, "done")
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(resolvedModel, error)

    const message = error instanceof Error ? error.message : String(error)
    consola.error(`[WS] Responses API error: ${message}`)
    sendErrorAndClose(ws, message)
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
  // Create the WebSocket handler
  const wsHandler = upgradeWs(() => ({
    onOpen(_event: Event, _ws: WSContext) {
      consola.debug("[WS] Responses API WebSocket connected")
    },

    onClose(_event: Event, _ws: WSContext) {
      consola.debug("[WS] Responses API WebSocket disconnected")
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      // Parse the incoming message
      let message: unknown
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data)
        message = JSON.parse(raw)
      } catch {
        sendErrorAndClose(ws, "Invalid JSON message", "invalid_request_error")
        return
      }

      // Extract and validate payload
      const payload = extractPayload(message)
      if (!payload) {
        sendErrorAndClose(
          ws,
          'Invalid message: expected { type: "response.create", response: { model, input, ... } }',
          "invalid_request_error",
        )
        return
      }

      // Handle the response creation
      await handleResponseCreate(ws, payload)
    },

    onError(event: Event, ws: WSContext) {
      consola.error("[WS] Responses API WebSocket error:", event)
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
