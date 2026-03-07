/**
 * TUI logger middleware — tracks every HTTP request in the TUI.
 *
 * Lifecycle:
 *   startRequest() → [handler runs] → finishRequest()
 *
 * Completion ownership:
 *   - Streaming API requests (SSE): consumer calls finishRequest asynchronously
 *     when the stream ends, with correct duration and full usage data.
 *     Middleware detects SSE content-type and skips finishRequest.
 *   - Non-streaming API requests: consumer calls finishRequest synchronously
 *     during await next(). Middleware's subsequent finishRequest is a no-op.
 *   - Simple routes (/models, /history, etc.): no consumer — middleware calls
 *     finishRequest after await next() with c.res.status.
 *   - WebSocket upgrades: middleware calls finishRequest with status 101.
 *
 * finishRequest is idempotent — second call for the same ID is a no-op.
 */

import type { Context, MiddlewareHandler, Next } from "hono"

import { getErrorMessage, HTTPError } from "~/lib/error"
import { getIsShuttingDown } from "~/lib/shutdown"

import { tuiLogger } from "./tracker"

export function tuiMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Reject new requests during shutdown
    if (getIsShuttingDown()) {
      return c.json({ type: "error", error: { type: "server_error", message: "Server is shutting down" } }, 503)
    }

    const method = c.req.method
    const path = c.req.path

    // Capture request body size from Content-Length header
    const contentLength = c.req.header("content-length")
    const requestBodySize = contentLength ? Number.parseInt(contentLength, 10) : undefined

    const tuiLogId = tuiLogger.startRequest({
      method,
      path,
      model: "",
      isHistoryAccess: path.startsWith("/history"),
      requestBodySize,
    })

    // Store tracking ID in context for handlers/consumers to use
    c.set("tuiLogId", tuiLogId)

    // Detect WebSocket upgrade before calling next() — after the upgrade,
    // c.res may not have a meaningful status.
    const isWebSocketUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket"

    try {
      await next()

      // WebSocket: treat as 101 regardless of c.res.status
      // (Bun returns 200, Node.js handles upgrade outside Hono)
      if (isWebSocketUpgrade) {
        tuiLogger.finishRequest(tuiLogId, { statusCode: 101 })
        return
      }

      // Streaming (SSE): the consumer handles completion asynchronously when
      // the stream finishes — with correct duration and full usage data.
      // Calling finishRequest here would finish prematurely (before the stream
      // ends, without usage).
      const contentType = c.res.headers.get("content-type")
      if (contentType?.includes("text/event-stream")) return

      // Non-streaming: finish the request with the actual HTTP status.
      // If a consumer already finished it synchronously during next(), this is a no-op.
      tuiLogger.finishRequest(tuiLogId, { statusCode: c.res.status })
    } catch (error) {
      tuiLogger.finishRequest(tuiLogId, {
        error: getErrorMessage(error),
        statusCode: error instanceof HTTPError ? error.status : undefined,
      })
      throw error
    }
  }
}
