/**
 * Direct Anthropic API handler.
 * Handles requests using the native Anthropic API without OpenAI translation.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"
import type { AnthropicMessage, AnthropicMessagesPayload, AnthropicStreamEventData } from "~/types/api/anthropic"

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
  checkNeedsCompactionAnthropic,
  sanitizeAnthropicMessages,
} from "~/lib/auto-truncate/anthropic"
import { hasKnownLimits, tryParseAndLearnLimit } from "~/lib/auto-truncate/common"
import { HTTPError } from "~/lib/error"
import { recordResponse, recordRewrites } from "~/lib/history"
import { state } from "~/lib/state"
import { requestTracker } from "~/lib/tui"
import { bytesToKB } from "~/lib/utils"
import { createAnthropicMessages, type AnthropicMessageResponse } from "~/services/copilot/create-anthropic-messages"

import {
  type ResponseContext,
  completeTracking,
  createTruncationMarker,
  failTracking,
  recordErrorResponse,
  recordStreamError,
  updateTrackerStatus,
} from "../shared"
import { translateErrorToAnthropicErrorEvent } from "./stream-translation"

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

  // Apply auto-truncate pre-check only if model has known limits from previous failures
  let effectivePayload = anthropicPayload
  let truncateResult: AnthropicAutoTruncateResult | undefined

  if (state.autoTruncate && selectedModel && hasKnownLimits(selectedModel.id)) {
    const check = await checkNeedsCompactionAnthropic(anthropicPayload, selectedModel, {
      checkTokenLimit: true,
      checkByteLimit: true,
    })
    consola.debug(
      `[Anthropic] Auto-truncate pre-check: ${check.currentTokens} tokens (limit ${check.tokenLimit}), `
        + `${bytesToKB(check.currentBytes)}KB (limit ${bytesToKB(check.byteLimit)}KB), `
        + `needed: ${check.needed}${check.reason ? ` (${check.reason})` : ""}`,
    )

    if (check.needed) {
      try {
        truncateResult = await autoTruncateAnthropic(anthropicPayload, selectedModel, {
          checkTokenLimit: true,
          checkByteLimit: true,
        })
        if (truncateResult.wasCompacted) {
          effectivePayload = truncateResult.payload
        }
      } catch (error) {
        consola.warn(
          "[Anthropic] Auto-truncate pre-check failed, proceeding with original payload:",
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // Always sanitize messages to filter orphaned tool_result/tool_use blocks
  // This handles cases where:
  // 1. Auto-truncate is disabled
  // 2. Auto-truncate didn't need to run (within limits)
  // 3. Original payload has orphaned blocks from client
  const {
    payload: sanitizedPayload,
    removedCount: orphanedRemovals,
    systemReminderRemovals,
  } = sanitizeAnthropicMessages(effectivePayload)
  effectivePayload = sanitizedPayload

  // Record all rewrites (truncation + sanitization + rewritten content)
  const hasTruncation = truncateResult?.wasCompacted
  const hasSanitization = orphanedRemovals > 0 || systemReminderRemovals > 0
  if (hasTruncation || hasSanitization) {
    const messageMapping = buildMessageMapping(anthropicPayload.messages, effectivePayload.messages)

    recordRewrites(ctx.historyId, {
      truncation:
        hasTruncation && truncateResult ?
          {
            removedMessageCount: truncateResult.removedMessageCount,
            originalTokens: truncateResult.originalTokens,
            compactedTokens: truncateResult.compactedTokens,
            processingTimeMs: truncateResult.processingTimeMs,
          }
        : undefined,
      sanitization:
        hasSanitization ?
          {
            removedBlockCount: orphanedRemovals,
            systemReminderRemovals,
          }
        : undefined,
      rewrittenMessages: convertAnthropicMessages(effectivePayload.messages),
      rewrittenSystem: typeof effectivePayload.system === "string" ? effectivePayload.system : undefined,
      messageMapping,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Set tracking tags for log display
  if (ctx.trackingId) {
    const tags: Array<string> = []
    if (truncateResult?.wasCompacted) tags.push("compact")
    if (effectivePayload.thinking && effectivePayload.thinking.type !== "disabled")
      tags.push(`thinking:${effectivePayload.thinking.type}`)
    if (tags.length > 0) requestTracker.updateRequest(ctx.trackingId, { tags })
  }

  try {
    const { result: response, queueWaitMs } = await executeWithAdaptiveRateLimit(() =>
      createAnthropicMessages(effectivePayload),
    )

    // eslint-disable-next-line require-atomic-updates -- ctx is a local object, no race
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
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, ctx, truncateResult)
  } catch (error) {
    // Reactive auto-truncate: on limit errors, learn the limit, truncate, and retry once
    if (
      state.autoTruncate
      && error instanceof HTTPError
      && selectedModel
      && !truncateResult?.wasCompacted // don't retry if we already truncated
    ) {
      const payloadBytes = JSON.stringify(effectivePayload).length
      const parsed = tryParseAndLearnLimit(error, selectedModel.id, payloadBytes)

      if (parsed) {
        consola.info(
          `[Anthropic] ${parsed.type} error for ${selectedModel.id}, truncating and retrying...`
            + (parsed.limit ? ` (limit: ${parsed.limit}, current: ${parsed.current})` : ""),
        )

        try {
          // Re-truncate from original payload using newly learned limits
          truncateResult = await autoTruncateAnthropic(anthropicPayload, selectedModel, {
            checkTokenLimit: true,
            checkByteLimit: true,
          })

          if (truncateResult.wasCompacted) {
            // Re-sanitize the truncated payload
            const {
              payload: retrySanitized,
              removedCount: retryOrphanedRemovals,
              systemReminderRemovals: retrySystemRemovals,
            } = sanitizeAnthropicMessages(truncateResult.payload)
            // eslint-disable-next-line require-atomic-updates -- effectivePayload is only used by the retry call below
            effectivePayload = retrySanitized

            // Record rewrites for the retried payload
            const retryMessageMapping = buildMessageMapping(anthropicPayload.messages, effectivePayload.messages)
            recordRewrites(ctx.historyId, {
              truncation: {
                removedMessageCount: truncateResult.removedMessageCount,
                originalTokens: truncateResult.originalTokens,
                compactedTokens: truncateResult.compactedTokens,
                processingTimeMs: truncateResult.processingTimeMs,
              },
              sanitization:
                retryOrphanedRemovals > 0 || retrySystemRemovals > 0 ?
                  { removedBlockCount: retryOrphanedRemovals, systemReminderRemovals: retrySystemRemovals }
                : undefined,
              rewrittenMessages: convertAnthropicMessages(effectivePayload.messages),
              rewrittenSystem: typeof effectivePayload.system === "string" ? effectivePayload.system : undefined,
              messageMapping: retryMessageMapping,
            })

            // Update tracking tags
            if (ctx.trackingId) {
              requestTracker.updateRequest(ctx.trackingId, { tags: ["compact", "retry"] })
            }

            const { result: retryResponse, queueWaitMs: retryQueueMs } = await executeWithAdaptiveRateLimit(() =>
              createAnthropicMessages(effectivePayload),
            )
            // eslint-disable-next-line require-atomic-updates -- ctx is a local object
            ctx.queueWaitMs = retryQueueMs

            if (Symbol.asyncIterator in (retryResponse as object)) {
              consola.debug("Streaming response from retry (direct Anthropic)")
              updateTrackerStatus(ctx.trackingId, "streaming")

              return streamSSE(c, async (stream) => {
                await handleDirectAnthropicStreamingResponse({
                  stream,
                  response: retryResponse as AsyncIterable<{ data?: string; event?: string }>,
                  anthropicPayload: effectivePayload,
                  ctx,
                })
              })
            }

            return handleDirectAnthropicNonStreamingResponse(
              c,
              retryResponse as AnthropicMessageResponse,
              ctx,
              truncateResult,
            )
          }
        } catch (retryError) {
          consola.warn("[Anthropic] Auto-truncate retry also failed:", retryError)
          recordErrorResponse(ctx, anthropicPayload.model, retryError)
          throw retryError
        }
      }
    }

    // Not retryable or retry conditions not met
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
                input: JSON.stringify(block.input),
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
                input: JSON.stringify(block.input),
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
  const contentBlocks: Array<{ type: string; text?: string; thinking?: string }> = []
  if (acc.thinkingContent) contentBlocks.push({ type: "thinking", thinking: acc.thinkingContent })
  if (acc.content) contentBlocks.push({ type: "text", text: acc.content })
  for (const tc of acc.toolCalls) {
    contentBlocks.push({ type: "tool_use", ...tc })
  }

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
      toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
    },
    Date.now() - ctx.startTime,
  )
}

/**
 * Check if two messages likely correspond to the same original message.
 * Used by buildMessageMapping to handle cases where sanitization removes
 * content blocks within a message (changing its shape) or removes entire messages.
 */
export function messagesMatch(orig: AnthropicMessage, rewritten: AnthropicMessage): boolean {
  if (orig.role !== rewritten.role) return false

  // String content: compare prefix
  if (typeof orig.content === "string" && typeof rewritten.content === "string")
    return (
      rewritten.content.startsWith(orig.content.slice(0, 100))
      || orig.content.startsWith(rewritten.content.slice(0, 100))
    )

  // Array content: compare first block's type and id
  const origBlocks = Array.isArray(orig.content) ? orig.content : []
  const rwBlocks = Array.isArray(rewritten.content) ? rewritten.content : []

  if (origBlocks.length === 0 || rwBlocks.length === 0) return true

  const ob = origBlocks[0]
  const rb = rwBlocks[0]
  if (ob.type !== rb.type) return false
  if (ob.type === "tool_use" && rb.type === "tool_use") return ob.id === rb.id
  if (ob.type === "tool_result" && rb.type === "tool_result") return ob.tool_use_id === rb.tool_use_id
  return true
}

/**
 * Build messageMapping (rwIdx → origIdx) for the direct Anthropic path.
 * Uses a two-pointer approach since rewritten messages maintain the same relative
 * order as originals (all transformations are deletions, never reorderings).
 */
export function buildMessageMapping(
  original: Array<AnthropicMessage>,
  rewritten: Array<AnthropicMessage>,
): Array<number> {
  const mapping: Array<number> = []
  let origIdx = 0

  for (const element of rewritten) {
    while (origIdx < original.length) {
      if (messagesMatch(original[origIdx], element)) {
        mapping.push(origIdx)
        origIdx++
        break
      }
      origIdx++
    }
  }

  // If matching missed some (shouldn't happen), fill with -1
  while (mapping.length < rewritten.length) {
    mapping.push(-1)
  }

  return mapping
}
