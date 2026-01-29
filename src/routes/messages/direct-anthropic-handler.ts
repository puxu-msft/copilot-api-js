/**
 * Direct Anthropic API handler.
 * Handles requests using the native Anthropic API without OpenAI translation.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"
import type {
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
} from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { awaitApproval } from "~/lib/approval"
import {
  type AnthropicAutoTruncateResult,
  autoTruncateAnthropic,
  checkNeedsCompactionAnthropic,
} from "~/lib/auto-truncate-anthropic"
import { HTTPError } from "~/lib/error"
import { recordResponse } from "~/lib/history"
import { state } from "~/lib/state"
import { requestTracker } from "~/lib/tui"
import {
  createAnthropicMessages,
  type AnthropicMessageResponse,
} from "~/services/copilot/create-anthropic-messages"

import {
  type ResponseContext,
  completeTracking,
  createTruncationMarker,
  failTracking,
  recordErrorResponse,
  recordStreamError,
  updateTrackerStatus,
} from "../shared"
import { extractToolCallsFromAnthropicContent } from "./message-utils"
import {
  type AnthropicStreamAccumulator,
  createAnthropicStreamAccumulator,
  processAnthropicEvent,
} from "./stream-accumulator"
import { translateErrorToAnthropicErrorEvent } from "./stream-translation"

/**
 * Handle completion using direct Anthropic API (no translation needed)
 */
export async function handleDirectAnthropicCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  ctx: ResponseContext,
) {
  consola.debug(
    "Using direct Anthropic API path for model:",
    anthropicPayload.model,
  )

  // Find model for auto-truncate and usage adjustment
  const selectedModel = state.models?.data.find(
    (m) => m.id === anthropicPayload.model,
  )

  // Apply auto-truncate if enabled
  let effectivePayload = anthropicPayload
  let truncateResult: AnthropicAutoTruncateResult | undefined

  if (state.autoTruncate && selectedModel) {
    const check = await checkNeedsCompactionAnthropic(
      anthropicPayload,
      selectedModel,
    )
    consola.debug(
      `[Anthropic] Auto-truncate check: ${check.currentTokens} tokens (limit ${check.tokenLimit}), `
        + `${Math.round(check.currentBytes / 1024)}KB (limit ${Math.round(check.byteLimit / 1024)}KB), `
        + `needed: ${check.needed}${check.reason ? ` (${check.reason})` : ""}`,
    )

    if (check.needed) {
      try {
        truncateResult = await autoTruncateAnthropic(
          anthropicPayload,
          selectedModel,
        )
        if (truncateResult.wasCompacted) {
          effectivePayload = truncateResult.payload
        }
      } catch (error) {
        consola.warn(
          "[Anthropic] Auto-truncate failed, proceeding with original payload:",
          error instanceof Error ? error.message : error,
        )
      }
    }
  } else if (state.autoTruncate && !selectedModel) {
    consola.debug(
      `[Anthropic] Model '${anthropicPayload.model}' not found, skipping auto-truncate`,
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    const { result: response, queueWaitMs } =
      await executeWithAdaptiveRateLimit(() =>
        createAnthropicMessages(effectivePayload),
      )

    ctx.queueWaitMs = queueWaitMs

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
    return handleDirectAnthropicNonStreamingResponse(
      c,
      response as AnthropicMessageResponse,
      ctx,
      truncateResult,
    )
  } catch (error) {
    // Handle 413 Request Entity Too Large with helpful debugging info
    if (error instanceof HTTPError && error.status === 413) {
      logPayloadSizeInfoAnthropic(effectivePayload, selectedModel)
    }

    recordErrorResponse(ctx, anthropicPayload.model, error)
    throw error
  }
}

/**
 * Log payload size info for debugging 413 errors
 */
function logPayloadSizeInfoAnthropic(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
) {
  const payloadSize = JSON.stringify(payload).length
  const messageCount = payload.messages.length
  const toolCount = payload.tools?.length ?? 0
  const systemSize = payload.system ? JSON.stringify(payload.system).length : 0

  consola.info(
    `[Anthropic 413] Payload size: ${Math.round(payloadSize / 1024)}KB, `
      + `messages: ${messageCount}, tools: ${toolCount}, system: ${Math.round(systemSize / 1024)}KB`,
  )

  if (model?.capabilities?.limits) {
    const limits = model.capabilities.limits
    consola.info(
      `[Anthropic 413] Model limits: context=${limits.max_context_window_tokens}, `
        + `prompt=${limits.max_prompt_tokens}, output=${limits.max_output_tokens}`,
    )
  }

  // Suggest enabling auto-truncate if disabled
  if (!state.autoTruncate) {
    consola.info(
      "[Anthropic 413] Consider enabling --auto-truncate to automatically reduce payload size",
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
  consola.debug(
    "Non-streaming response from Copilot (direct Anthropic):",
    JSON.stringify(response).slice(-400),
  )

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
                input: JSON.stringify(block.input),
              }
            }
            case "thinking": {
              return { type: "thinking" as const, thinking: block.thinking }
            }
            default: {
              // Handle any future block types gracefully
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
async function handleDirectAnthropicStreamingResponse(
  opts: DirectAnthropicStreamHandlerOptions,
) {
  const { stream, response, anthropicPayload, ctx } = opts
  const acc = createAnthropicStreamAccumulator()

  try {
    for await (const rawEvent of response) {
      consola.debug(
        "Direct Anthropic raw stream event:",
        JSON.stringify(rawEvent),
      )

      // Handle end of stream
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      let event: AnthropicStreamEventData
      try {
        event = JSON.parse(rawEvent.data) as AnthropicStreamEventData
      } catch (parseError) {
        consola.error(
          "Failed to parse Anthropic stream event:",
          parseError,
          rawEvent.data,
        )
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
    completeTracking(
      ctx.trackingId,
      acc.inputTokens,
      acc.outputTokens,
      ctx.queueWaitMs,
    )
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
function recordStreamingResponse(
  acc: AnthropicStreamAccumulator,
  fallbackModel: string,
  ctx: ResponseContext,
) {
  const contentBlocks: Array<{ type: string; text?: string }> = []
  if (acc.content) contentBlocks.push({ type: "text", text: acc.content })
  for (const tc of acc.toolCalls) {
    contentBlocks.push({ type: "tool_use", ...tc })
  }

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: acc.model || fallbackModel,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      stop_reason: acc.stopReason || undefined,
      content:
        contentBlocks.length > 0 ?
          { role: "assistant", content: contentBlocks }
        : null,
      toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
    },
    Date.now() - ctx.startTime,
  )
}
