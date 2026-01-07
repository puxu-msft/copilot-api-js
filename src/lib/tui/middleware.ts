// Custom Hono logger middleware that integrates with TUI request tracker
// Replaces the default hono/logger for cleaner, more informative output

import type { Context, MiddlewareHandler, Next } from "hono"

import { requestTracker } from "./tracker"

/**
 * Custom logger middleware that tracks requests through the TUI system
 * Shows single-line output: METHOD /path 200 1.2s 1.5K/500 model-name
 *
 * For streaming responses (SSE), the handler is responsible for calling
 * completeRequest after the stream finishes.
 */
export function tuiLogger(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const method = c.req.method
    const path = c.req.path

    // Start tracking with empty model (will be updated by handler if available)
    const trackingId = requestTracker.startRequest(method, path, "")

    // Store tracking ID in context for handlers to update
    c.set("trackingId", trackingId)

    try {
      await next()

      // Check if this is a streaming response (SSE)
      const contentType = c.res.headers.get("content-type") ?? ""
      const isStreaming = contentType.includes("text/event-stream")

      // For streaming responses, the handler will call completeRequest
      // after the stream finishes with the actual token counts
      if (isStreaming) {
        return
      }

      // Complete tracking with response info for non-streaming
      const status = c.res.status

      // Get usage and model from response headers (set by handler if available)
      const inputTokens = c.res.headers.get("x-input-tokens")
      const outputTokens = c.res.headers.get("x-output-tokens")
      const model = c.res.headers.get("x-model")

      // Update model if available
      if (model) {
        const request = requestTracker.getRequest(trackingId)
        if (request) {
          request.model = model
        }
      }

      requestTracker.completeRequest(
        trackingId,
        status,
        inputTokens && outputTokens ?
          {
            inputTokens: Number.parseInt(inputTokens, 10),
            outputTokens: Number.parseInt(outputTokens, 10),
          }
        : undefined,
      )
    } catch (error) {
      requestTracker.failRequest(
        trackingId,
        error instanceof Error ? error.message : "Unknown error",
      )
      throw error
    }
  }
}
