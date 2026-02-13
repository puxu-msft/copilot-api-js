/**
 * Direct Anthropic API handler.
 * Handles requests using the native Anthropic API without OpenAI translation.
 */

import type { Context } from "hono"

import consola from "consola"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

import type { MessagesPayload } from "~/types/api/anthropic"
import type { ServerSentEventMessage } from "fetch-event-stream"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import {
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { processAnthropicStream } from "~/lib/anthropic/stream-processor"
import { awaitApproval } from "~/lib/approval"
import {
  type AnthropicAutoTruncateResult,
  autoTruncateAnthropic,
} from "~/lib/auto-truncate/anthropic"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate/common"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { recordRewrites, type MessageContent } from "~/lib/history"
import { state } from "~/lib/state"
import { buildMessageMapping } from "~/lib/translation/message-mapping"
import { tuiLogger } from "~/lib/tui"
import { createAnthropicMessages, type AnthropicMessageResponse } from "~/services/copilot/create-anthropic-messages"

import type { FormatAdapter } from "../shared/pipeline"

import {
  type ResponseContext,
  createTruncationMarker,
  extractErrorContent,
  finalizeRequest,
  updateTrackerStatus,
} from "../shared"
import { logPayloadSizeInfoAnthropic } from "../shared/payload"
import { buildAnthropicStreamResult } from "../shared/recording"
import { prependMarkerToResponse } from "../shared/response"
import { executeRequestPipeline } from "../shared/pipeline"
import { createAutoTruncateStrategy, type TruncateResult } from "../shared/strategies/auto-truncate"

// Handle completion using direct Anthropic API (no translation needed)
export async function handleDirectAnthropicCompletion(
  c: Context,
  anthropicPayload: MessagesPayload,
  ctx: ResponseContext,
) {
  consola.debug("Using direct Anthropic API path for model:", anthropicPayload.model)

  // Find model for auto-truncate and usage adjustment
  const selectedModel = state.models?.data.find((m) => m.id === anthropicPayload.model)

  // Always sanitize messages to filter orphaned tool_result/tool_use blocks
  const {
    payload: initialSanitized,
    removedCount: initialOrphanedRemovals,
    systemReminderRemovals: initialSystemRemovals,
  } = sanitizeAnthropicMessages(anthropicPayload)

  // Record initial sanitization if anything was removed
  if (initialOrphanedRemovals > 0 || initialSystemRemovals > 0) {
    const messageMapping = buildMessageMapping(anthropicPayload.messages, initialSanitized.messages)
    recordRewrites(ctx.historyId, {
      sanitization: {
        removedBlockCount: initialOrphanedRemovals,
        systemReminderRemovals: initialSystemRemovals,
      },
      rewrittenMessages: initialSanitized.messages as unknown as MessageContent[],
      rewrittenSystem: typeof initialSanitized.system === "string" ? initialSanitized.system : undefined,
      messageMapping,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Set initial tracking tags for log display
  if (ctx.tuiLogId) {
    const tags: Array<string> = []
    if (initialSanitized.thinking && initialSanitized.thinking.type !== "disabled")
      tags.push(`thinking:${initialSanitized.thinking.type}`)
    if (tags.length > 0) tuiLogger.updateRequest(ctx.tuiLogId, { tags })
  }

  // Build adapter and strategy for the pipeline
  const adapter: FormatAdapter<MessagesPayload> = {
    format: "anthropic",
    sanitize: (p) => sanitizeAnthropicMessages(p),
    execute: (p) => executeWithAdaptiveRateLimit(() => createAnthropicMessages(p)),
    logPayloadSize: (p) => logPayloadSizeInfoAnthropic(p, selectedModel),
  }

  const strategies = [
    createAutoTruncateStrategy<MessagesPayload>({
      truncate: (p, model, opts) =>
        autoTruncateAnthropic(p, model, opts) as Promise<TruncateResult<MessagesPayload>>,
      resanitize: (p) => sanitizeAnthropicMessages(p),
      isEnabled: () => state.autoTruncate,
      label: "Anthropic",
    }),
  ]

  // Track truncation result for non-streaming response marker
  let truncateResult: AnthropicAutoTruncateResult | undefined

  try {
    const result = await executeRequestPipeline({
      adapter,
      strategies,
      payload: initialSanitized,
      originalPayload: anthropicPayload,
      model: selectedModel,
      maxRetries: MAX_AUTO_TRUNCATE_RETRIES,
      onRetry: (_attempt, _strategyName, newPayload, meta) => {
        // Capture truncation result for response marker
        const retryTruncateResult = meta?.truncateResult as AnthropicAutoTruncateResult | undefined
        if (retryTruncateResult) {
          truncateResult = retryTruncateResult
        }

        // Record rewrites for the retried payload
        const retrySanitization = meta?.sanitization as
          | { removedCount: number; systemReminderRemovals: number }
          | undefined
        const retryMessageMapping = buildMessageMapping(anthropicPayload.messages, newPayload.messages)
        recordRewrites(ctx.historyId, {
          truncation:
            retryTruncateResult ?
              {
                removedMessageCount: retryTruncateResult.removedMessageCount,
                originalTokens: retryTruncateResult.originalTokens,
                compactedTokens: retryTruncateResult.compactedTokens,
                processingTimeMs: retryTruncateResult.processingTimeMs,
              }
            : undefined,
          sanitization:
            retrySanitization && (retrySanitization.removedCount > 0 || retrySanitization.systemReminderRemovals > 0) ?
              {
                removedBlockCount: retrySanitization.removedCount,
                systemReminderRemovals: retrySanitization.systemReminderRemovals,
              }
            : undefined,
          rewrittenMessages: newPayload.messages as unknown as MessageContent[],
          rewrittenSystem: typeof newPayload.system === "string" ? newPayload.system : undefined,
          messageMapping: retryMessageMapping,
        })

        // Update tracking tags
        if (ctx.tuiLogId) {
          const retryAttempt = (meta?.attempt as number | undefined) ?? 1
          const retryTags = ["truncated", `retry-${retryAttempt}`]
          if (newPayload.thinking && newPayload.thinking.type !== "disabled")
            retryTags.push(`thinking:${newPayload.thinking.type}`)
          tuiLogger.updateRequest(ctx.tuiLogId, { tags: retryTags })
        }
      },
    })

    ctx.queueWaitMs = result.queueWaitMs
    const response = result.response
    const effectivePayload = result.effectivePayload as MessagesPayload

    // Check if response is streaming (AsyncIterable)
    if (Symbol.asyncIterator in (response as object)) {
      consola.debug("Streaming response from Copilot (direct Anthropic)")
      updateTrackerStatus(ctx.tuiLogId, "streaming")

      return streamSSE(c, async (stream) => {
        await handleDirectAnthropicStreamingResponse({
          stream,
          response: response as AsyncIterable<ServerSentEventMessage>,
          anthropicPayload: effectivePayload,
          ctx,
        })
      })
    }

    // Non-streaming response
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, ctx, truncateResult)
  } catch (error) {
    finalizeRequest(ctx, {
      success: false,
      model: anthropicPayload.model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : String(error),
      content: extractErrorContent(error),
      durationMs: Date.now() - ctx.startTime,
    })
    throw error
  }
}

// Handle non-streaming direct Anthropic response
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  ctx: ResponseContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
) {

  finalizeRequest(ctx, {
    success: true,
    model: response.model,
    usage: response.usage,
    stop_reason: response.stop_reason ?? undefined,
    content: { role: "assistant", content: response.content },
    durationMs: Date.now() - ctx.startTime,
    queueWaitMs: ctx.queueWaitMs,
  })

  // Add truncation marker to response if verbose mode and truncation occurred
  let finalResponse = response
  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToResponse(response, marker)
  }

  return c.json(finalResponse)
}

// Options for handleDirectAnthropicStreamingResponse
interface DirectAnthropicStreamHandlerOptions {
  stream: SSEStreamingApi
  response: AsyncIterable<ServerSentEventMessage>
  anthropicPayload: MessagesPayload
  ctx: ResponseContext
}

// Handle streaming direct Anthropic response (passthrough SSE events)
async function handleDirectAnthropicStreamingResponse(opts: DirectAnthropicStreamHandlerOptions) {
  const { stream, response, anthropicPayload, ctx } = opts
  const acc = createAnthropicStreamAccumulator()

  try {
    for await (const { raw: rawEvent } of processAnthropicStream(response, acc)) {
      // Forward every event to client — proxy preserves upstream data
      await stream.writeSSE({
        data: rawEvent.data ?? "",
        event: rawEvent.event,
        id: String(rawEvent.id),
        retry: rawEvent.retry,
      })
    }

    const result = buildAnthropicStreamResult(acc, anthropicPayload.model, ctx)
    finalizeRequest(ctx, result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    consola.error("Direct Anthropic stream error:", error)
    finalizeRequest(ctx, {
      success: false,
      model: acc.model || anthropicPayload.model,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      error: errorMessage,
      content: acc.content ? { role: "assistant", content: [{ type: "text", text: acc.content }] } : null,
      durationMs: Date.now() - ctx.startTime,
    })

    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({
        type: "error",
        error: { type: "api_error", message: errorMessage },
      }),
    })
  }
}
