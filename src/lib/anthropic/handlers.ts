/**
 * Anthropic stream processing, response handlers, and completion orchestration.
 * Parses SSE events, accumulates for history/tracking, checks shutdown signals.
 * Handles both streaming and non-streaming response finalization.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

import type { MessagesPayload, StreamEvent } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { createAnthropicMessages, type AnthropicMessageResponse } from "~/lib/anthropic/client"
import { awaitApproval } from "~/lib/approval"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate-common"
import { processAnthropicSystem } from "~/lib/config/system-prompt"
import { recordRewrites, type MessageContent, type ToolDefinition, recordRequest } from "~/lib/history"
import {
  type ResponseContext,
  buildAnthropicStreamResult,
  createTruncationMarker,
  extractErrorContent,
  finalizeRequest,
  updateTrackerStatus,
} from "~/lib/request"
import { logPayloadSizeInfoAnthropic } from "~/lib/request/payload"
import { executeRequestPipeline, type FormatAdapter } from "~/lib/request/pipeline"
import { prependMarkerToResponse } from "~/lib/request/response"
import { createAutoTruncateStrategy, type TruncateResult } from "~/lib/request/strategies/auto-truncate"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { buildMessageMapping } from "~/lib/translation/message-mapping"
import { tuiLogger } from "~/lib/tui"

import { handleTranslatedCompletion } from "../translation/handlers"
import { type AnthropicAutoTruncateResult, autoTruncateAnthropic } from "./auto-truncate"
import { sanitizeAnthropicMessages, type SanitizationStats } from "./sanitize"
import {
  type AnthropicStreamAccumulator,
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./stream-accumulator"

// ============================================================================
// API routing
// ============================================================================

export interface ApiRoutingDecision {
  supported: boolean
  reason: string
}

/**
 * Check if a model supports direct Anthropic API.
 * Returns a decision with reason so callers can log/display the routing rationale.
 */
export function supportsDirectAnthropicApi(modelId: string): ApiRoutingDecision {
  // If redirectAnthropic is enabled, force all requests through OpenAI translation
  if (state.redirectAnthropic) {
    return { supported: false, reason: "redirectAnthropic is enabled" }
  }

  const model = state.models?.data.find((m) => m.id === modelId)
  if (model?.vendor !== "Anthropic") {
    return { supported: false, reason: `vendor is "${model?.vendor ?? "unknown"}", not Anthropic` }
  }

  // Validate that the model supports the /v1/messages endpoint
  if (model?.supported_endpoints && !model.supported_endpoints.includes("/v1/messages")) {
    return { supported: false, reason: "model does not support /v1/messages endpoint" }
  }

  return { supported: true, reason: "Anthropic vendor with /v1/messages support" }
}

// ============================================================================
// Main entry point — Anthropic /v1/messages completion
// ============================================================================

/**
 * Handle an Anthropic messages completion request.
 * Processes system prompt, records to history, builds context,
 * and routes to direct Anthropic or translated OpenAI path.
 */
export async function handleAnthropicMessagesCompletion(c: Context, anthropicPayload: MessagesPayload) {
  // System prompt collection + config-based overrides (always active)
  if (anthropicPayload.system) {
    anthropicPayload.system = await processAnthropicSystem(anthropicPayload.system)
  }

  // Record request to history with full message content
  const historyId = recordRequest("anthropic", {
    model: anthropicPayload.model,
    messages: anthropicPayload.messages as unknown as Array<MessageContent>,
    stream: anthropicPayload.stream ?? false,
    tools: anthropicPayload.tools as Array<ToolDefinition> | undefined,
    max_tokens: anthropicPayload.max_tokens,
    temperature: anthropicPayload.temperature,
    system: anthropicPayload.system,
  })

  // Get tracking ID and use tracker's startTime for consistent timing
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Update TUI tracker with model info
  if (tuiLogId) tuiLogger.updateRequest(tuiLogId, { model: anthropicPayload.model })

  const tuiLogEntry = tuiLogId ? tuiLogger.getRequest(tuiLogId) : undefined
  const startTime = tuiLogEntry?.startTime ?? Date.now()
  const ctx: ResponseContext = { historyId, tuiLogId, startTime }

  // Use direct Anthropic API or fallback to OpenAI translation
  const routingDecision = supportsDirectAnthropicApi(anthropicPayload.model)
  consola.debug(`[AnthropicRouting] ${anthropicPayload.model}: ${routingDecision.reason}`)
  return routingDecision.supported ?
      handleDirectAnthropicCompletion(c, anthropicPayload, ctx)
    : handleTranslatedCompletion(c, anthropicPayload, ctx)
}

// ============================================================================
// Direct Anthropic completion orchestration
// ============================================================================

// Handle completion using direct Anthropic API (no translation needed)
async function handleDirectAnthropicCompletion(c: Context, anthropicPayload: MessagesPayload, ctx: ResponseContext) {
  consola.debug("Using direct Anthropic API path for model:", anthropicPayload.model)

  // Find model for auto-truncate and usage adjustment
  const selectedModel = state.models?.data.find((m) => m.id === anthropicPayload.model)

  // Always sanitize messages to filter orphaned tool_result/tool_use blocks
  const { payload: initialSanitized, stats: sanitizationStats } = sanitizeAnthropicMessages(anthropicPayload)

  // Record initial sanitization if anything was removed
  if (sanitizationStats.totalBlocksRemoved > 0 || sanitizationStats.systemReminderRemovals > 0) {
    const messageMapping = buildMessageMapping(anthropicPayload.messages, initialSanitized.messages)
    recordRewrites(ctx.historyId, {
      sanitization: sanitizationStats,
      rewrittenMessages: initialSanitized.messages as unknown as Array<MessageContent>,
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
      truncate: (p, model, opts) => autoTruncateAnthropic(p, model, opts) as Promise<TruncateResult<MessagesPayload>>,
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
        const retrySanitization = meta?.sanitization as SanitizationStats | undefined
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
            (
              retrySanitization
              && (retrySanitization.totalBlocksRemoved > 0 || retrySanitization.systemReminderRemovals > 0)
            ) ?
              retrySanitization
            : undefined,
          rewrittenMessages: newPayload.messages as unknown as Array<MessageContent>,
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

// ============================================================================
// Stream processing
// ============================================================================

/** Processed event from the Anthropic stream */
export interface ProcessedAnthropicEvent {
  /** Original SSE message for forwarding */
  raw: ServerSentEventMessage
  /** Parsed event for accumulation (undefined for keepalives / [DONE]) */
  parsed?: StreamEvent
}

/**
 * Process raw Anthropic SSE stream: parse events, accumulate, check shutdown.
 * Yields each event for the caller to forward to the client.
 */
export async function* processAnthropicStream(
  response: AsyncIterable<ServerSentEventMessage>,
  acc: AnthropicStreamAccumulator,
): AsyncGenerator<ProcessedAnthropicEvent> {
  for await (const rawEvent of response) {
    // Check shutdown abort signal — break out of stream gracefully
    if (getShutdownSignal()?.aborted) break

    // No data — keepalive, nothing to accumulate
    if (!rawEvent.data) {
      consola.debug("SSE event with no data (keepalive):", rawEvent.event ?? "(no event type)")
      yield { raw: rawEvent }
      continue
    }

    // [DONE] is not part of the SSE spec - it's an OpenAI convention.
    // Copilot's gateway injects it at the end of all streams, including Anthropic.
    // see refs/vscode-copilot-chat/src/platform/endpoint/node/messagesApi.ts:326
    if (rawEvent.data === "[DONE]") break

    // Try to parse and accumulate for history/tracking
    let parsed: StreamEvent | undefined
    try {
      parsed = JSON.parse(rawEvent.data) as StreamEvent
      accumulateAnthropicStreamEvent(parsed, acc)
    } catch (parseError) {
      consola.error("Failed to parse Anthropic stream event:", parseError, rawEvent.data)
    }

    yield { raw: rawEvent, parsed }

    // Error event is terminal — Anthropic sends no more events after this
    if (parsed?.type === "error") break
  }
}

// ============================================================================
// Response handlers (streaming / non-streaming)
// ============================================================================

/** Options for handleDirectAnthropicStreamingResponse */
export interface DirectAnthropicStreamHandlerOptions {
  stream: SSEStreamingApi
  response: AsyncIterable<ServerSentEventMessage>
  anthropicPayload: MessagesPayload
  ctx: ResponseContext
}

/** Handle streaming direct Anthropic response (passthrough SSE events) */
export async function handleDirectAnthropicStreamingResponse(opts: DirectAnthropicStreamHandlerOptions) {
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

    if (acc.streamError) {
      finalizeRequest(ctx, {
        success: false,
        model: acc.model || anthropicPayload.model,
        usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
        error: `${acc.streamError.type}: ${acc.streamError.message}`,
        content:
          acc.content ? { role: "assistant" as const, content: [{ type: "text" as const, text: acc.content }] } : null,
        durationMs: Date.now() - ctx.startTime,
      })
    } else {
      const result = buildAnthropicStreamResult(acc, anthropicPayload.model, ctx)
      finalizeRequest(ctx, result)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    let content: {
      role: "assistant"
      content: typeof acc.contentBlocks | Array<{ type: "text"; text: string }>
    } | null = null
    if (acc.contentBlocks.length > 0) {
      content = { role: "assistant" as const, content: acc.contentBlocks }
    } else if (acc.content) {
      content = { role: "assistant" as const, content: [{ type: "text" as const, text: acc.content }] }
    }

    consola.error("Direct Anthropic stream error:", error)
    finalizeRequest(ctx, {
      success: false,
      model: acc.model || anthropicPayload.model,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      error: errorMessage,
      content,
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

/** Handle non-streaming direct Anthropic response */
export function handleDirectAnthropicNonStreamingResponse(
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
