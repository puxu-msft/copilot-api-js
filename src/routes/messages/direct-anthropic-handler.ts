/**
 * Direct Anthropic API handler.
 * Handles requests using the native Anthropic API without OpenAI translation.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"
import type { AnthropicMessagesPayload, AnthropicStreamEventData } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { convertAnthropicMessages, extractToolCallsFromAnthropicContent } from "~/lib/anthropic/message-utils"
import {
  type AnthropicStreamAccumulator,
  createAnthropicStreamAccumulator,
  processAnthropicEvent,
} from "~/lib/anthropic/stream-accumulator"
import { awaitApproval } from "~/lib/approval"
import {
  type AnthropicAutoTruncateResult,
  autoTruncateAnthropic,
} from "~/lib/auto-truncate/anthropic"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate/common"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { recordResponse, recordRewrites } from "~/lib/history"
import { state } from "~/lib/state"
import { buildMessageMapping } from "~/lib/translation/message-mapping"
import { requestTracker } from "~/lib/tui"
import { bytesToKB } from "~/lib/utils"
import { createAnthropicMessages, type AnthropicMessageResponse } from "~/services/copilot/create-anthropic-messages"

import type { FormatAdapter } from "../shared/pipeline"

import {
  type ResponseContext,
  completeTracking,
  createTruncationMarker,
  failTracking,
  recordErrorResponse,
  recordStreamError,
  updateTrackerStatus,
} from "../shared"
import { executeRequestPipeline } from "../shared/pipeline"
import { createAutoTruncateStrategy, type TruncateResult } from "../shared/strategies/auto-truncate"
import { translateErrorToAnthropicErrorEvent } from "./stream-translation"

/** Parse a JSON string to object, returning the value as-is if already an object */
function safeParseJson(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Handle completion using direct Anthropic API (no translation needed)
 */
export async function handleDirectAnthropicCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
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
      rewrittenMessages: convertAnthropicMessages(initialSanitized.messages),
      rewrittenSystem: typeof initialSanitized.system === "string" ? initialSanitized.system : undefined,
      messageMapping,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Set initial tracking tags for log display
  if (ctx.trackingId) {
    const tags: Array<string> = []
    if (initialSanitized.thinking && initialSanitized.thinking.type !== "disabled")
      tags.push(`thinking:${initialSanitized.thinking.type}`)
    if (tags.length > 0) requestTracker.updateRequest(ctx.trackingId, { tags })
  }

  // Build adapter and strategy for the pipeline
  const adapter: FormatAdapter<AnthropicMessagesPayload> = {
    format: "anthropic",
    sanitize: (p) => sanitizeAnthropicMessages(p),
    execute: (p) => executeWithAdaptiveRateLimit(() => createAnthropicMessages(p)),
    logPayloadSize: (p) => logPayloadSizeInfoAnthropic(p, selectedModel),
  }

  const strategies = [
    createAutoTruncateStrategy<AnthropicMessagesPayload>({
      truncate: (p, model, opts) =>
        autoTruncateAnthropic(p, model, opts) as Promise<TruncateResult<AnthropicMessagesPayload>>,
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
          rewrittenMessages: convertAnthropicMessages(newPayload.messages),
          rewrittenSystem: typeof newPayload.system === "string" ? newPayload.system : undefined,
          messageMapping: retryMessageMapping,
        })

        // Update tracking tags
        if (ctx.trackingId) {
          const retryAttempt = (meta?.attempt as number | undefined) ?? 1
          const retryTags = ["compact", `retry-${retryAttempt}`]
          if (newPayload.thinking && newPayload.thinking.type !== "disabled")
            retryTags.push(`thinking:${newPayload.thinking.type}`)
          requestTracker.updateRequest(ctx.trackingId, { tags: retryTags })
        }
      },
    })

    ctx.queueWaitMs = result.queueWaitMs
    const response = result.response
    const effectivePayload = result.effectivePayload as AnthropicMessagesPayload

    // Check if response is streaming (AsyncIterable)
    if (Symbol.asyncIterator in (response as object)) {
      consola.debug("Streaming response from Copilot (direct Anthropic)")
      updateTrackerStatus(ctx.trackingId, "streaming")

      return streamSSE(c, async (stream) => {
        await handleDirectAnthropicStreamingResponse({
          stream,
          response: response as AsyncIterable<{
            data?: string
            event?: string
          }>,
          anthropicPayload: effectivePayload,
          ctx,
        })
      })
    }

    // Non-streaming response
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, ctx, truncateResult)
  } catch (error) {
    recordErrorResponse(ctx, anthropicPayload.model, error)
    throw error
  }
}

/**
 * Log payload size info for debugging 413 errors
 */
function logPayloadSizeInfoAnthropic(payload: AnthropicMessagesPayload, model: Model | undefined) {
  const payloadSize = JSON.stringify(payload).length
  const messageCount = payload.messages.length
  const toolCount = payload.tools?.length ?? 0
  const systemSize = payload.system ? JSON.stringify(payload.system).length : 0

  consola.info(
    `[Anthropic 413] Payload size: ${bytesToKB(payloadSize)}KB, `
      + `messages: ${messageCount}, tools: ${toolCount}, system: ${bytesToKB(systemSize)}KB`,
  )

  if (model?.capabilities?.limits) {
    const limits = model.capabilities.limits
    consola.info(
      `[Anthropic 413] Model limits: context=${limits.max_context_window_tokens}, `
        + `prompt=${limits.max_prompt_tokens}, output=${limits.max_output_tokens}`,
    )
  }
}

/**
 * Handle non-streaming direct Anthropic response
 */
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  ctx: ResponseContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
) {
  consola.debug("Non-streaming response from Copilot (direct Anthropic):", JSON.stringify(response).slice(-400))

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: response.model,
      usage: response.usage,
      stop_reason: response.stop_reason ?? undefined,
      content: {
        role: "assistant",
        content: response.content.map((block) => {
          switch (block.type) {
            case "text": {
              return { type: "text" as const, text: block.text }
            }
            case "tool_use": {
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input,
              }
            }
            case "thinking": {
              return { type: "thinking" as const, thinking: block.thinking }
            }
            case "redacted_thinking": {
              return { type: "redacted_thinking" as const }
            }
            case "server_tool_use": {
              return {
                type: "server_tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input,
              }
            }
            default: {
              // Handle server tool results (e.g., tool_search_tool_result) and other future block types
              const b = block as Record<string, unknown>
              if ("tool_use_id" in b && typeof b.tool_use_id === "string") {
                return { type: b.type as string, tool_use_id: b.tool_use_id }
              }
              return { type: (block as { type: string }).type }
            }
          }
        }),
      },
      toolCalls: extractToolCallsFromAnthropicContent(response.content),
    },
    Date.now() - ctx.startTime,
  )

  if (ctx.trackingId) {
    requestTracker.updateRequest(ctx.trackingId, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      queueWaitMs: ctx.queueWaitMs,
    })
  }

  // Add truncation marker to response if verbose mode and truncation occurred
  let finalResponse = response
  if (state.verbose && truncateResult?.wasCompacted) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToAnthropicResponse(response, marker)
  }

  return c.json(finalResponse)
}

/**
 * Prepend marker to Anthropic response content (at the beginning of first text block)
 */
function prependMarkerToAnthropicResponse(
  response: AnthropicMessageResponse & {
    usage: { input_tokens: number; output_tokens: number }
  },
  marker: string,
): AnthropicMessageResponse & {
  usage: { input_tokens: number; output_tokens: number }
} {
  if (!marker) return response

  const content = [...response.content]
  const firstTextIndex = content.findIndex((block) => block.type === "text")

  if (firstTextIndex !== -1) {
    const textBlock = content[firstTextIndex]
    if (textBlock.type === "text") {
      content[firstTextIndex] = {
        ...textBlock,
        text: marker + textBlock.text,
      }
    }
  } else {
    // No text block, add one at the start
    content.unshift({ type: "text" as const, text: marker })
  }

  return { ...response, content }
}

/** Options for handleDirectAnthropicStreamingResponse */
interface DirectAnthropicStreamHandlerOptions {
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> }
  response: AsyncIterable<{ data?: string; event?: string }>
  anthropicPayload: AnthropicMessagesPayload
  ctx: ResponseContext
}

/**
 * Handle streaming direct Anthropic response (passthrough SSE events)
 */
async function handleDirectAnthropicStreamingResponse(opts: DirectAnthropicStreamHandlerOptions) {
  const { stream, response, anthropicPayload, ctx } = opts
  const acc = createAnthropicStreamAccumulator()

  try {
    for await (const rawEvent of response) {
      consola.debug("Direct Anthropic raw stream event:", JSON.stringify(rawEvent))

      // Handle end of stream
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      let event: AnthropicStreamEventData
      try {
        event = JSON.parse(rawEvent.data) as AnthropicStreamEventData
      } catch (parseError) {
        consola.error("Failed to parse Anthropic stream event:", parseError, rawEvent.data)
        continue
      }

      // Accumulate data for history/tracking
      processAnthropicEvent(event, acc)

      // Forward event directly to client
      await stream.writeSSE({
        event: rawEvent.event || event.type,
        data: rawEvent.data,
      })
    }

    recordStreamingResponse(acc, anthropicPayload.model, ctx)
    completeTracking(ctx.trackingId, acc.inputTokens, acc.outputTokens, ctx.queueWaitMs)
  } catch (error) {
    consola.error("Direct Anthropic stream error:", error)
    recordStreamError({
      acc,
      fallbackModel: anthropicPayload.model,
      ctx,
      error,
    })
    failTracking(ctx.trackingId, error)

    const errorEvent = translateErrorToAnthropicErrorEvent()
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }
}

// Record streaming response to history
function recordStreamingResponse(acc: AnthropicStreamAccumulator, fallbackModel: string, ctx: ResponseContext) {
  const contentBlocks: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }> = []
  if (acc.thinkingContent) contentBlocks.push({ type: "thinking", thinking: acc.thinkingContent })
  if (acc.content) contentBlocks.push({ type: "text", text: acc.content })
  for (const tc of acc.toolCalls) {
    contentBlocks.push({
      type: tc.blockType,
      id: tc.id,
      name: tc.name,
      input: safeParseJson(tc.input),
    })
  }

  const toolCalls =
    acc.toolCalls.length > 0 ?
      acc.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: safeParseJson(tc.input) }))
    : undefined

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: acc.model || fallbackModel,
      usage: {
        input_tokens: acc.inputTokens,
        output_tokens: acc.outputTokens,
        ...(acc.cacheReadTokens > 0 && { cache_read_input_tokens: acc.cacheReadTokens }),
        ...(acc.cacheCreationTokens > 0 && { cache_creation_input_tokens: acc.cacheCreationTokens }),
      },
      stop_reason: acc.stopReason || undefined,
      content: contentBlocks.length > 0 ? { role: "assistant", content: contentBlocks } : null,
      toolCalls,
    },
    Date.now() - ctx.startTime,
  )
}

// Re-exported from lib/translation for backward compatibility
export { buildMessageMapping, messagesMatch } from "~/lib/translation/message-mapping"
