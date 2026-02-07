/**
 * Translated (OpenAI) completion handler.
 * Handles requests by translating between Anthropic and OpenAI formats.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessagesPayload, AnthropicStreamState } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { convertAnthropicMessages, extractToolCallsFromContent } from "~/lib/anthropic/message-utils"
import {
  type AnthropicStreamAccumulator,
  createAnthropicStreamAccumulator,
  processAnthropicEvent,
} from "~/lib/anthropic/stream-accumulator"
import { awaitApproval } from "~/lib/approval"
import {
  AUTO_TRUNCATE_RETRY_FACTOR,
  MAX_AUTO_TRUNCATE_RETRIES,
  tryParseAndLearnLimit,
} from "~/lib/auto-truncate/common"
import {
  autoTruncateOpenAI,
  createTruncationResponseMarkerOpenAI,
  sanitizeOpenAIMessages,
} from "~/lib/auto-truncate/openai"
import { HTTPError } from "~/lib/error"
import { recordResponse, recordRewrites } from "~/lib/history"
import { sanitizeAnthropicMessages } from "~/lib/message-sanitizer"
import { state } from "~/lib/state"
import { requestTracker } from "~/lib/tui"
import { bytesToKB } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type ResponseContext,
  buildFinalPayload,
  completeTracking,
  failTracking,
  isNonStreaming,
  logPayloadSizeInfo,
  recordErrorResponse,
  recordStreamError,
  updateTrackerStatus,
} from "../shared"
import { buildMessageMapping } from "./direct-anthropic-handler"
import { translateToAnthropic, translateToOpenAI, type ToolNameMapping } from "./non-stream-translation"
import { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from "./stream-translation"

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
 * Handle completion using OpenAI translation path (legacy)
 */
export async function handleTranslatedCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  ctx: ResponseContext,
) {
  const { payload: translatedPayload, toolNameMapping } = translateToOpenAI(anthropicPayload)
  consola.debug("Translated OpenAI request payload:", JSON.stringify(translatedPayload))

  const selectedModel = state.models?.data.find((model) => model.id === translatedPayload.model)

  // Sanitize (no pre-truncation — truncation is now reactive)
  const {
    finalPayload: initialOpenAIPayload,
    sanitizeRemovedCount,
    systemReminderRemovals,
  } = buildFinalPayload(translatedPayload, selectedModel)

  // Sanitize the original Anthropic messages to produce rewrittenMessages
  // in Anthropic format (matching the original payload format for frontend rendering).
  const {
    payload: sanitizedAnthropicPayload,
    removedCount: anthropicOrphanedRemovals,
    systemReminderRemovals: anthropicSysRemovals,
  } = sanitizeAnthropicMessages(anthropicPayload)

  const anthropicMessageMapping = buildMessageMapping(anthropicPayload.messages, sanitizedAnthropicPayload.messages)

  // Record initial sanitization rewrites
  const hasSanitization =
    sanitizeRemovedCount > 0 || systemReminderRemovals > 0 || anthropicOrphanedRemovals > 0 || anthropicSysRemovals > 0
  if (hasSanitization) {
    recordRewrites(ctx.historyId, {
      sanitization: {
        removedBlockCount: sanitizeRemovedCount + anthropicOrphanedRemovals,
        systemReminderRemovals: systemReminderRemovals + anthropicSysRemovals,
      },
      rewrittenMessages: convertAnthropicMessages(sanitizedAnthropicPayload.messages),
      rewrittenSystem:
        typeof sanitizedAnthropicPayload.system === "string" ? sanitizedAnthropicPayload.system : undefined,
      messageMapping: anthropicMessageMapping,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Set initial tracking tags for log display
  if (ctx.trackingId) {
    const tags: Array<string> = []
    if (anthropicPayload.thinking && anthropicPayload.thinking.type !== "disabled")
      tags.push(`thinking:${anthropicPayload.thinking.type}`)
    if (tags.length > 0) requestTracker.updateRequest(ctx.trackingId, { tags })
  }

  // Reactive retry loop: send full payload first, then truncate and retry on limit errors
  let effectivePayload = initialOpenAIPayload
  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_AUTO_TRUNCATE_RETRIES; attempt++) {
    try {
      const { result: response, queueWaitMs } = await executeWithAdaptiveRateLimit(() =>
        createChatCompletions(effectivePayload),
      )

      // eslint-disable-next-line require-atomic-updates -- ctx is a local object, no race
      ctx.queueWaitMs = queueWaitMs

      if (isNonStreaming(response)) {
        return handleNonStreamingResponse({
          c,
          response,
          toolNameMapping,
          ctx,
        })
      }

      consola.debug("Streaming response from Copilot")
      updateTrackerStatus(ctx.trackingId, "streaming")

      return streamSSE(c, async (stream) => {
        await handleStreamingResponse({
          stream,
          response,
          toolNameMapping,
          anthropicPayload,
          ctx,
        })
      })
    } catch (error) {
      lastError = error

      // Check if this is a retryable limit error
      if (state.autoTruncate && error instanceof HTTPError && selectedModel && attempt < MAX_AUTO_TRUNCATE_RETRIES) {
        const payloadBytes = JSON.stringify(effectivePayload).length
        const parsed = tryParseAndLearnLimit(error, selectedModel.id, payloadBytes)

        if (parsed) {
          // Calculate target limits based on error type
          let targetTokenLimit: number | undefined
          let targetByteLimitBytes: number | undefined

          if (parsed.type === "token_limit" && parsed.limit) {
            targetTokenLimit = Math.floor(parsed.limit * AUTO_TRUNCATE_RETRY_FACTOR)
            consola.info(
              `[Translated] Attempt ${attempt + 1}/${MAX_AUTO_TRUNCATE_RETRIES + 1}: `
                + `Token limit error (${parsed.current}>${parsed.limit}), `
                + `retrying with limit ${targetTokenLimit}...`,
            )
          } else if (parsed.type === "body_too_large") {
            targetByteLimitBytes = Math.floor(payloadBytes * AUTO_TRUNCATE_RETRY_FACTOR)
            consola.info(
              `[Translated] Attempt ${attempt + 1}/${MAX_AUTO_TRUNCATE_RETRIES + 1}: `
                + `Body too large (${bytesToKB(payloadBytes)}KB), `
                + `retrying with limit ${bytesToKB(targetByteLimitBytes)}KB...`,
            )
          }

          try {
            // Truncate from original translated payload using target limits
            const retryTruncateResult = await autoTruncateOpenAI(translatedPayload, selectedModel, {
              checkTokenLimit: true,
              checkByteLimit: true,
              targetTokenLimit,
              targetByteLimitBytes,
            })

            if (retryTruncateResult.wasCompacted) {
              const { payload: retrySanitized } = sanitizeOpenAIMessages(retryTruncateResult.payload)
              effectivePayload = retrySanitized // eslint-disable-line require-atomic-updates -- sequential loop, no race

              // eslint-disable-next-line require-atomic-updates -- ctx is a local object
              ctx.truncateResult = retryTruncateResult

              // Update tracking tags
              if (ctx.trackingId) {
                const retryTags = ["compact", `retry-${attempt + 1}`]
                if (anthropicPayload.thinking && anthropicPayload.thinking.type !== "disabled")
                  retryTags.push(`thinking:${anthropicPayload.thinking.type}`)
                requestTracker.updateRequest(ctx.trackingId, { tags: retryTags })
              }

              // Continue to next iteration to retry
              continue
            } else {
              // Truncation didn't help, break out
              break
            }
          } catch (truncateError) {
            consola.warn(
              `[Translated] Auto-truncate failed on attempt ${attempt + 1}:`,
              truncateError instanceof Error ? truncateError.message : truncateError,
            )
            break
          }
        }
      }

      // Not retryable or no more retries left
      break
    }
  }

  // If we exit the loop with an error, handle it
  if (lastError) {
    if (lastError instanceof HTTPError && lastError.status === 413) {
      await logPayloadSizeInfo(effectivePayload, selectedModel)
    }

    recordErrorResponse(ctx, anthropicPayload.model, lastError)
    throw lastError instanceof Error ? lastError : new Error("Unknown error")
  }

  // Should not reach here
  throw new Error("Unexpected state in retry loop")
}

/** Options for handleNonStreamingResponse */
interface NonStreamingOptions {
  c: Context
  response: ChatCompletionResponse
  toolNameMapping: ToolNameMapping
  ctx: ResponseContext
}

// Handle non-streaming response
function handleNonStreamingResponse(opts: NonStreamingOptions) {
  const { c, response, toolNameMapping, ctx } = opts
  consola.debug("Non-streaming response from Copilot:", JSON.stringify(response).slice(-400))
  let anthropicResponse = translateToAnthropic(response, toolNameMapping)
  consola.debug("Translated Anthropic response:", JSON.stringify(anthropicResponse))

  // Prepend truncation marker if auto-truncate was performed (only in verbose mode)
  if (state.verbose && ctx.truncateResult?.wasCompacted) {
    const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
    anthropicResponse = prependMarkerToAnthropicResponse(anthropicResponse, marker)
  }

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: anthropicResponse.model,
      usage: anthropicResponse.usage,
      stop_reason: anthropicResponse.stop_reason ?? undefined,
      content: {
        role: "assistant",
        content: anthropicResponse.content.map((block) => {
          if (block.type === "text") {
            return { type: "text", text: block.text }
          }
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            }
          }
          return { type: block.type }
        }),
      },
      toolCalls: extractToolCallsFromContent(anthropicResponse.content),
    },
    Date.now() - ctx.startTime,
  )

  if (ctx.trackingId) {
    requestTracker.updateRequest(ctx.trackingId, {
      inputTokens: anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens,
      queueWaitMs: ctx.queueWaitMs,
    })
  }

  return c.json(anthropicResponse)
}

// Prepend marker to Anthropic response content (at the beginning)
function prependMarkerToAnthropicResponse(
  response: ReturnType<typeof translateToAnthropic>,
  marker: string,
): ReturnType<typeof translateToAnthropic> {
  if (!marker) return response

  // Find first text block and prepend, or add new text block at start
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
    // No text block found, add one at the beginning
    content.unshift({ type: "text", text: marker })
  }

  return { ...response, content }
}

/** Options for handleStreamingResponse */
interface StreamHandlerOptions {
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> }
  response: AsyncIterable<{ data?: string }>
  toolNameMapping: ToolNameMapping
  anthropicPayload: AnthropicMessagesPayload
  ctx: ResponseContext
}

// Handle streaming response
async function handleStreamingResponse(opts: StreamHandlerOptions) {
  const { stream, response, toolNameMapping, anthropicPayload, ctx } = opts
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  const acc = createAnthropicStreamAccumulator()

  try {
    // Prepend truncation marker as first content block if auto-truncate was performed
    if (ctx.truncateResult?.wasCompacted) {
      const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
      await sendTruncationMarkerEvent(stream, streamState, marker, anthropicPayload.model)
      acc.content += marker
    }

    await processStreamChunks({
      stream,
      response,
      toolNameMapping,
      streamState,
      acc,
    })

    recordStreamingResponse(acc, anthropicPayload.model, ctx)
    completeTracking(ctx.trackingId, acc.inputTokens, acc.outputTokens, ctx.queueWaitMs)
  } catch (error) {
    consola.error(`[TranslatedHandler] Stream error for model "${anthropicPayload.model}":`, error)
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

// Send truncation marker as Anthropic SSE events
async function sendTruncationMarkerEvent(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  streamState: AnthropicStreamState,
  marker: string,
  model: string,
) {
  // Must send message_start before any content blocks
  if (!streamState.messageStartSent) {
    // Set flag before await to satisfy require-atomic-updates lint rule
    streamState.messageStartSent = true
    const messageStartEvent = {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    }
    await stream.writeSSE({
      event: "message_start",
      data: JSON.stringify(messageStartEvent),
    })
  }

  // Start a new content block for the marker
  const blockStartEvent = {
    type: "content_block_start",
    index: streamState.contentBlockIndex,
    content_block: { type: "text", text: "" },
  }
  await stream.writeSSE({
    event: "content_block_start",
    data: JSON.stringify(blockStartEvent),
  })

  // Send the marker text as a delta
  const deltaEvent = {
    type: "content_block_delta",
    index: streamState.contentBlockIndex,
    delta: { type: "text_delta", text: marker },
  }
  await stream.writeSSE({
    event: "content_block_delta",
    data: JSON.stringify(deltaEvent),
  })

  // Stop the content block
  const blockStopEvent = {
    type: "content_block_stop",
    index: streamState.contentBlockIndex,
  }
  await stream.writeSSE({
    event: "content_block_stop",
    data: JSON.stringify(blockStopEvent),
  })

  streamState.contentBlockIndex++
}

/** Options for processing stream chunks */
interface ProcessChunksOptions {
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> }
  response: AsyncIterable<{ data?: string }>
  toolNameMapping: ToolNameMapping
  streamState: AnthropicStreamState
  acc: AnthropicStreamAccumulator
}

// Process all stream chunks
async function processStreamChunks(opts: ProcessChunksOptions) {
  const { stream, response, toolNameMapping, streamState, acc } = opts
  for await (const rawEvent of response) {
    consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
    if (rawEvent.data === "[DONE]") break
    if (!rawEvent.data) continue

    let chunk: ChatCompletionChunk
    try {
      chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    } catch (parseError) {
      consola.error("Failed to parse stream chunk:", parseError, rawEvent.data)
      continue
    }

    if (chunk.model && !acc.model) acc.model = chunk.model

    const events = translateChunkToAnthropicEvents(chunk, streamState, toolNameMapping)

    for (const event of events) {
      consola.debug("Translated Anthropic event:", JSON.stringify(event))
      processAnthropicEvent(event, acc)
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      })
    }
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
