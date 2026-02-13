/**
 * Request tracking and finalization.
 * Single entry point for completing requests — distributes to History and TUI.
 */

import type { OpenAIAutoTruncateResult } from "~/lib/auto-truncate/openai"


import { recordResponse, type MessageContent } from "~/lib/history"
import { tuiLogger } from "~/lib/tui"

/** Context for recording responses and tracking */
export interface ResponseContext {
  historyId: string
  tuiLogId: string | undefined
  startTime: number
  truncateResult?: OpenAIAutoTruncateResult
  /** Time spent waiting in rate-limit queue (ms) */
  queueWaitMs?: number
}

/** Unified result for request completion — carries data in its richest form */
export interface RequestResult {
  success: boolean
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }
  stop_reason?: string
  error?: string
  content: unknown
  durationMs: number
  queueWaitMs?: number
  statusCode?: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Helper to update tracker status */
export function updateTrackerStatus(tuiLogId: string | undefined, status: "executing" | "streaming") {
  if (!tuiLogId) return
  tuiLogger.updateRequest(tuiLogId, { status })
}

/** Extract error content from an error object for history recording */
export function extractErrorContent(error: unknown): { role: string; content: Array<{ type: string; text: string }> } | null {
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
      return {
        role: "assistant",
        content: [
          { type: "text", text: `[API Error Response${status ? ` - HTTP ${status}` : ""}]\n\n${formattedBody}` },
        ],
      }
    }
  }
  return null
}

// ─── Unified Finalization ───────────────────────────────────────────────────

/**
 * Unified request finalization — single entry point for both History and TUI.
 * Handlers build RequestResult with complete data, this function distributes.
 */
export function finalizeRequest(ctx: ResponseContext, result: RequestResult): void {
  // 1. History: record with full data
  recordResponse(
    ctx.historyId,
    {
      success: result.success,
      model: result.model,
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? undefined,
      },
      stop_reason: result.stop_reason,
      error: result.error,
      content: result.content as MessageContent | null,
    },
    result.durationMs,
  )

  // 2. TUI: extract what it needs
  if (ctx.tuiLogId) {
    tuiLogger.updateRequest(ctx.tuiLogId, {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadInputTokens: result.usage.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? undefined,
      queueWaitMs: result.queueWaitMs,
    })
    if (result.success) {
      tuiLogger.completeRequest(ctx.tuiLogId, result.statusCode ?? 200, {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      })
    } else {
      tuiLogger.failRequest(ctx.tuiLogId, result.error ?? "Unknown error")
    }
  }
}
