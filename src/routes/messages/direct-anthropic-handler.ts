/**
 * Direct Anthropic API handler.
 * Handles requests using the native Anthropic API without OpenAI translation.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicStreamEventData,
} from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { awaitApproval } from "~/lib/approval"
import {
  autoTruncateAnthropic,
  checkNeedsCompactionAnthropic,
} from "~/lib/auto-truncate-anthropic"
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

  // Apply auto-truncate if enabled
  let effectivePayload = anthropicPayload
  if (state.autoTruncate) {
    const model = state.models?.data.find(
      (m) => m.id === anthropicPayload.model,
    )
    if (model) {
      const check = checkNeedsCompactionAnthropic(anthropicPayload, model)
      consola.debug(
        `[Anthropic] Auto-truncate check: ${check.currentTokens} tokens (limit ${check.tokenLimit}), `
          + `${Math.round(check.currentBytes / 1024)}KB (limit ${Math.round(check.byteLimit / 1024)}KB), `
          + `needed: ${check.needed}${check.reason ? ` (${check.reason})` : ""}`,
      )

      if (check.needed) {
        try {
          const result = autoTruncateAnthropic(anthropicPayload, model)
          if (result.wasCompacted) {
            effectivePayload = result.payload
          }
        } catch (error) {
          consola.warn(
            "[Anthropic] Auto-truncate failed, proceeding with original payload:",
            error instanceof Error ? error.message : error,
          )
        }
      }
    } else {
      consola.debug(
        `[Anthropic] Model '${anthropicPayload.model}' not found, skipping auto-truncate`,
      )
    }
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
    )
  } catch (error) {
    recordErrorResponse(ctx, anthropicPayload.model, error)
    throw error
  }
}

/**
 * Handle non-streaming direct Anthropic response
 */
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  ctx: ResponseContext,
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

  return c.json(response)
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
