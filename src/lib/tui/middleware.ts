/**
 * Custom Hono logger middleware that integrates with TUI request tracker.
 * Replaces the default hono/logger for cleaner, more informative output.
 */

import type { Context, MiddlewareHandler, Next } from "hono"

import { getErrorMessage } from "~/lib/error"
import { getIsShuttingDown } from "~/lib/shutdown"

import { tuiLogger } from "./tracker"

/**
 * Custom logger middleware that tracks requests through the TUI system
 * Shows single-line output: METHOD /path 200 1.2s 1.5K/500 model-name
 *
 * For streaming responses (SSE), the handler is responsible for calling
 * completeRequest after the stream finishes.
 */
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

    // Detect /history API access for gray display
    const isHistoryAccess = path.startsWith("/history")

    // Start tracking with empty model (will be updated by handler if available)
    const tuiLogId = tuiLogger.startRequest({
      method,
      path,
      model: "",
      isHistoryAccess,
      requestBodySize,
    })

    // Store tracking ID in context for handlers to update
    c.set("tuiLogId", tuiLogId)

    try {
      await next()

      const status = c.res.status

      // WebSocket upgrade (101 Switching Protocols) - complete immediately
      if (status === 101) {
        tuiLogger.completeRequest(tuiLogId, 101)
        return
      }

      // Check if this is a streaming response (SSE)
      const contentType = c.res.headers.get("content-type")
      const isStreaming = contentType?.includes("text/event-stream") ?? false

      // For streaming responses, the handler will call completeRequest
      // after the stream finishes with the actual token counts
      if (isStreaming) {
        return
      }

      // Get usage and model from response headers (set by handler if available)
      const inputTokens = c.res.headers.get("x-input-tokens")
      const outputTokens = c.res.headers.get("x-output-tokens")
      const model = c.res.headers.get("x-model")

      // Update model if available
      if (model) {
        tuiLogger.updateRequest(tuiLogId, { model })
      }

      tuiLogger.completeRequest(
        tuiLogId,
        status,
        inputTokens && outputTokens ?
          {
            inputTokens: Number.parseInt(inputTokens, 10),
            outputTokens: Number.parseInt(outputTokens, 10),
          }
        : undefined,
      )
    } catch (error) {
      tuiLogger.failRequest(tuiLogId, getErrorMessage(error))
      throw error
    }
  }
}
