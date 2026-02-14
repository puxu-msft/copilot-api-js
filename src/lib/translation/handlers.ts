/**
 * Translated (OpenAI) completion handler.
 * Handles requests by translating between Anthropic and OpenAI formats.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { FormatAdapter } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { awaitApproval } from "~/lib/approval"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate-common"
import { recordRewrites, type MessageContent } from "~/lib/history"
import { autoTruncateOpenAI, createTruncationResponseMarkerOpenAI } from "~/lib/openai/auto-truncate"
import { createChatCompletions, type ChatCompletionResponse, type ChatCompletionsPayload } from "~/lib/openai/client"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import {
  type ResponseContext,
  extractErrorContent,
  finalizeRequest,
  isNonStreaming,
  logPayloadSizeInfo,
  updateTrackerStatus,
} from "~/lib/request"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildAnthropicStreamResult } from "~/lib/request/recording"
import { prependMarkerToResponse } from "~/lib/request/response"
import { createAutoTruncateStrategy, type TruncateResult } from "~/lib/request/strategies/auto-truncate"
import { state } from "~/lib/state"
import { buildMessageMapping } from "~/lib/translation/message-mapping"
import { translateToAnthropic, translateToOpenAI, type ToolNameMapping } from "~/lib/translation/non-stream"
import {
  type StreamState,
  translateErrorToAnthropicErrorEvent,
  processTranslatedStream,
  sendTruncationMarkerEvents,
} from "~/lib/translation/stream"
import { tuiLogger } from "~/lib/tui"

// Handle completion using OpenAI translation path (legacy)
export async function handleTranslatedCompletion(c: Context, anthropicPayload: MessagesPayload, ctx: ResponseContext) {
  const { payload: translatedPayload, toolNameMapping } = translateToOpenAI(anthropicPayload)

  const selectedModel = state.models?.data.find((model) => model.id === translatedPayload.model)

  // Sanitize OpenAI messages (filter orphaned tool blocks, system-reminders)
  const {
    payload: initialOpenAIPayload,
    removedCount: sanitizeRemovedCount,
    systemReminderRemovals,
  } = sanitizeOpenAIMessages(translatedPayload)

  // Sanitize the original Anthropic messages to produce rewrittenMessages
  // in Anthropic format (matching the original payload format for frontend rendering).
  const { payload: sanitizedAnthropicPayload, stats: anthropicSanitizationStats } =
    sanitizeAnthropicMessages(anthropicPayload)

  const anthropicMessageMapping = buildMessageMapping(anthropicPayload.messages, sanitizedAnthropicPayload.messages)

  // Record initial sanitization rewrites
  const hasSanitization =
    sanitizeRemovedCount > 0
    || systemReminderRemovals > 0
    || anthropicSanitizationStats.totalBlocksRemoved > 0
    || anthropicSanitizationStats.systemReminderRemovals > 0
  if (hasSanitization) {
    recordRewrites(ctx.historyId, {
      sanitization: {
        totalBlocksRemoved: sanitizeRemovedCount + anthropicSanitizationStats.totalBlocksRemoved,
        orphanedToolUseCount: anthropicSanitizationStats.orphanedToolUseCount,
        orphanedToolResultCount: anthropicSanitizationStats.orphanedToolResultCount,
        fixedNameCount: anthropicSanitizationStats.fixedNameCount,
        emptyTextBlocksRemoved: anthropicSanitizationStats.emptyTextBlocksRemoved,
        systemReminderRemovals: systemReminderRemovals + anthropicSanitizationStats.systemReminderRemovals,
      },
      rewrittenMessages: sanitizedAnthropicPayload.messages as unknown as Array<MessageContent>,
      rewrittenSystem:
        typeof sanitizedAnthropicPayload.system === "string" ? sanitizedAnthropicPayload.system : undefined,
      messageMapping: anthropicMessageMapping,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Set initial tracking tags for log display
  if (ctx.tuiLogId) {
    const tags: Array<string> = []
    if (anthropicPayload.thinking && anthropicPayload.thinking.type !== "disabled")
      tags.push(`thinking:${anthropicPayload.thinking.type}`)
    if (tags.length > 0) tuiLogger.updateRequest(ctx.tuiLogId, { tags })
  }

  // Build adapter and strategy for the pipeline
  const adapter: FormatAdapter<ChatCompletionsPayload> = {
    format: "openai",
    sanitize: (p) => sanitizeOpenAIMessages(p),
    execute: (p) => executeWithAdaptiveRateLimit(() => createChatCompletions(p)),
    logPayloadSize: (p) => logPayloadSizeInfo(p, selectedModel),
  }

  const strategies = [
    createAutoTruncateStrategy<ChatCompletionsPayload>({
      truncate: (p, model, opts) =>
        autoTruncateOpenAI(p, model, opts) as Promise<TruncateResult<ChatCompletionsPayload>>,
      resanitize: (p) => sanitizeOpenAIMessages(p),
      isEnabled: () => state.autoTruncate,
      label: "Translated",
    }),
  ]

  try {
    const result = await executeRequestPipeline({
      adapter,
      strategies,
      payload: initialOpenAIPayload,
      originalPayload: translatedPayload,
      model: selectedModel,
      maxRetries: MAX_AUTO_TRUNCATE_RETRIES,
      onRetry: (attempt, _strategyName, _newPayload, meta) => {
        // Capture truncation result for response marker
        const retryTruncateResult = meta?.truncateResult as
          | { wasTruncated: boolean; payload: ChatCompletionsPayload }
          | undefined
        if (retryTruncateResult) {
          ctx.truncateResult = retryTruncateResult as ResponseContext["truncateResult"]
        }

        // Update tracking tags
        if (ctx.tuiLogId) {
          const retryTags = ["truncated", `retry-${attempt + 1}`]
          if (anthropicPayload.thinking && anthropicPayload.thinking.type !== "disabled")
            retryTags.push(`thinking:${anthropicPayload.thinking.type}`)
          tuiLogger.updateRequest(ctx.tuiLogId, { tags: retryTags })
        }
      },
    })

    ctx.queueWaitMs = result.queueWaitMs
    const response = result.response

    if (isNonStreaming(response as ChatCompletionResponse | AsyncIterable<unknown>)) {
      return handleNonStreamingResponse({
        c,
        response: response as ChatCompletionResponse,
        toolNameMapping,
        ctx,
      })
    }

    consola.debug("Streaming response from Copilot")
    updateTrackerStatus(ctx.tuiLogId, "streaming")

    return streamSSE(c, async (stream) => {
      await handleStreamingResponse({
        stream,
        response: response as AsyncIterable<ServerSentEventMessage>,
        toolNameMapping,
        anthropicPayload,
        ctx,
      })
    })
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

// Options for handleNonStreamingResponse
interface NonStreamingOptions {
  c: Context
  response: ChatCompletionResponse
  toolNameMapping: ToolNameMapping
  ctx: ResponseContext
}

// Handle non-streaming response
function handleNonStreamingResponse(opts: NonStreamingOptions) {
  const { c, response, toolNameMapping, ctx } = opts
  let anthropicResponse = translateToAnthropic(response, toolNameMapping)

  // Prepend truncation marker if auto-truncate was performed (only in verbose mode)
  if (state.verbose && ctx.truncateResult?.wasTruncated) {
    const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
    anthropicResponse = prependMarkerToResponse(anthropicResponse, marker)
  }

  finalizeRequest(ctx, {
    success: true,
    model: anthropicResponse.model,
    usage: anthropicResponse.usage,
    stop_reason: anthropicResponse.stop_reason ?? undefined,
    content: { role: "assistant", content: anthropicResponse.content },
    durationMs: Date.now() - ctx.startTime,
    queueWaitMs: ctx.queueWaitMs,
  })

  return c.json(anthropicResponse)
}

// Options for handleStreamingResponse
interface StreamHandlerOptions {
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> }
  response: AsyncIterable<ServerSentEventMessage>
  toolNameMapping: ToolNameMapping
  anthropicPayload: MessagesPayload
  ctx: ResponseContext
}

// Handle streaming response
async function handleStreamingResponse(opts: StreamHandlerOptions) {
  const { stream, response, toolNameMapping, anthropicPayload, ctx } = opts
  const streamState: StreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  const acc = createAnthropicStreamAccumulator()

  try {
    // Prepend truncation marker as first content block if auto-truncate was performed
    if (ctx.truncateResult?.wasTruncated) {
      const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
      await sendTruncationMarkerEvents(stream, streamState, marker, anthropicPayload.model)
      acc.content += marker
    }

    for await (const event of processTranslatedStream(response, streamState, toolNameMapping, acc)) {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }

    const result = buildAnthropicStreamResult(acc, anthropicPayload.model, ctx)
    finalizeRequest(ctx, result)
  } catch (error) {
    consola.error(`[TranslatedHandler] Stream error for model "${anthropicPayload.model}":`, error)
    finalizeRequest(ctx, {
      success: false,
      model: acc.model || anthropicPayload.model,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      error: error instanceof Error ? error.message : String(error),
      content: acc.content ? { role: "assistant", content: [{ type: "text", text: acc.content }] } : null,
      durationMs: Date.now() - ctx.startTime,
    })

    const errorEvent = translateErrorToAnthropicErrorEvent()
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }
}
