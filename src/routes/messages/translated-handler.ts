/**
 * Translated (OpenAI) completion handler.
 * Handles requests by translating between Anthropic and OpenAI formats.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { awaitApproval } from "~/lib/approval"
import { createTruncationResponseMarkerOpenAI } from "~/lib/auto-truncate-openai"
import { HTTPError } from "~/lib/error"
import { recordResponse } from "~/lib/history"
import { state } from "~/lib/state"
import { requestTracker } from "~/lib/tui"
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
import { extractToolCallsFromContent } from "./message-utils"
import {
  translateToAnthropic,
  translateToOpenAI,
  type ToolNameMapping,
} from "./non-stream-translation"
import {
  type AnthropicStreamAccumulator,
  createAnthropicStreamAccumulator,
  processAnthropicEvent,
} from "./stream-accumulator"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

/**
 * Handle completion using OpenAI translation path (legacy)
 */
export async function handleTranslatedCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  ctx: ResponseContext,
) {
  const { payload: translatedPayload, toolNameMapping } =
    translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(translatedPayload),
  )

  // Auto-truncate if enabled and needed
  const selectedModel = state.models?.data.find(
    (model) => model.id === translatedPayload.model,
  )

  const { finalPayload: openAIPayload, truncateResult } =
    await buildFinalPayload(translatedPayload, selectedModel)
  if (truncateResult) {
    ctx.truncateResult = truncateResult
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    const { result: response, queueWaitMs } =
      await executeWithAdaptiveRateLimit(() =>
        createChatCompletions(openAIPayload),
      )

    // Store queueWaitMs in context for later use
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
    // Handle 413 Request Entity Too Large with helpful debugging info
    if (error instanceof HTTPError && error.status === 413) {
      await logPayloadSizeInfo(openAIPayload, selectedModel)
    }

    recordErrorResponse(ctx, anthropicPayload.model, error)
    throw error
  }
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
  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(response).slice(-400),
  )
  let anthropicResponse = translateToAnthropic(response, toolNameMapping)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )

  // Prepend truncation marker if auto-truncate was performed (only in verbose mode)
  if (state.verbose && ctx.truncateResult?.wasCompacted) {
    const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
    anthropicResponse = prependMarkerToAnthropicResponse(
      anthropicResponse,
      marker,
    )
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
              input: JSON.stringify(block.input),
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
      await sendTruncationMarkerEvent(stream, streamState, marker)
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
    completeTracking(
      ctx.trackingId,
      acc.inputTokens,
      acc.outputTokens,
      ctx.queueWaitMs,
    )
  } catch (error) {
    consola.error("Stream error:", error)
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
) {
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

    const events = translateChunkToAnthropicEvents(
      chunk,
      streamState,
      toolNameMapping,
    )

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
