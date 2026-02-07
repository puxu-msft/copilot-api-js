/**
 * TUI request tracking helpers.
 */

import type { OpenAIAutoTruncateResult } from "~/lib/auto-truncate/openai"

import { recordResponse } from "~/lib/history"
import { requestTracker } from "~/lib/tui"
import { getErrorMessage } from "~/lib/utils"

/** Context for recording responses and tracking */
export interface ResponseContext {
  historyId: string
  trackingId: string | undefined
  startTime: number
  truncateResult?: OpenAIAutoTruncateResult
  /** Time spent waiting in rate-limit queue (ms) */
  queueWaitMs?: number
}

/** Helper to update tracker model */
export function updateTrackerModel(trackingId: string | undefined, model: string) {
  if (!trackingId) return
  const request = requestTracker.getRequest(trackingId)
  if (request) request.model = model
}

/** Helper to update tracker status */
export function updateTrackerStatus(trackingId: string | undefined, status: "executing" | "streaming") {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, { status })
}

/** Complete TUI tracking */
export function completeTracking(
  trackingId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  queueWaitMs?: number,
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, {
    inputTokens,
    outputTokens,
    queueWaitMs,
  })
  requestTracker.completeRequest(trackingId, 200, { inputTokens, outputTokens })
}

/** Fail TUI tracking */
export function failTracking(trackingId: string | undefined, error: unknown) {
  if (!trackingId) return
  requestTracker.failRequest(trackingId, getErrorMessage(error, "Stream error"))
}

/** Record error response to history, preserving full error details for debugging */
export function recordErrorResponse(ctx: ResponseContext, model: string, error: unknown) {
  const errorMessage = getErrorMessage(error)

  // For HTTP errors, preserve the raw API response body as content for debugging
  let content: { role: string; content: Array<{ type: string; text: string }> } | null = null
  if (
    error instanceof Error
    && "responseText" in error
    && typeof (error as { responseText: unknown }).responseText === "string"
  ) {
    const responseText = (error as { responseText: string }).responseText
    const status = "status" in error ? (error as { status: number }).status : undefined
    if (responseText) {
      let formattedBody: string
      try {
        formattedBody = JSON.stringify(JSON.parse(responseText), null, 2)
      } catch {
        formattedBody = responseText
      }
      content = {
        role: "assistant",
        content: [
          { type: "text", text: `[API Error Response${status ? ` - HTTP ${status}` : ""}]\n\n${formattedBody}` },
        ],
      }
    }
  }

  recordResponse(
    ctx.historyId,
    {
      success: false,
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: errorMessage,
      content,
    },
    Date.now() - ctx.startTime,
  )
}

/** Base accumulator interface for stream error recording */
interface BaseStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  content: string
}

/** Record streaming error to history, preserving any data accumulated before the error */
export function recordStreamError(opts: {
  acc: BaseStreamAccumulator
  fallbackModel: string
  ctx: ResponseContext
  error: unknown
}) {
  const { acc, fallbackModel, ctx, error } = opts
  recordResponse(
    ctx.historyId,
    {
      success: false,
      model: acc.model || fallbackModel,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      error: getErrorMessage(error, "Stream error"),
      content: acc.content ? { role: "assistant", content: [{ type: "text", text: acc.content }] } : null,
    },
    Date.now() - ctx.startTime,
  )
}
