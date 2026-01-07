/* eslint-disable max-params, complexity, @typescript-eslint/no-unnecessary-condition, default-case */
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  type MessageContent,
  recordRequest,
  recordResponse,
} from "~/lib/history"
import { executeWithRateLimit } from "~/lib/queue"
import { state } from "~/lib/state"
import { requestTracker } from "~/lib/tui"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Update TUI tracker with model info
  const trackingId = c.get("trackingId") as string | undefined
  updateTrackerModel(trackingId, anthropicPayload.model)

  // Record request to history with full message content
  const historyId = recordRequest("anthropic", {
    model: anthropicPayload.model,
    messages: convertAnthropicMessages(anthropicPayload.messages),
    stream: anthropicPayload.stream ?? false,
    tools: anthropicPayload.tools?.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    max_tokens: anthropicPayload.max_tokens,
    temperature: anthropicPayload.temperature,
    system: extractSystemPrompt(anthropicPayload.system),
  })

  const { payload: openAIPayload, toolNameMapping } =
    translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    // Use queue-based rate limiting
    const response = await executeWithRateLimit(state, () =>
      createChatCompletions(openAIPayload),
    )

    if (isNonStreaming(response)) {
      return handleNonStreamingResponse(
        c,
        response,
        toolNameMapping,
        historyId,
        trackingId,
        startTime,
      )
    }

    consola.debug("Streaming response from Copilot")
    updateTrackerStatus(trackingId, "streaming")

    return streamSSE(c, async (stream) => {
      await handleStreamingResponse(
        stream,
        response,
        toolNameMapping,
        anthropicPayload,
        historyId,
        trackingId,
        startTime,
      )
    })
  } catch (error) {
    recordResponse(
      historyId,
      {
        success: false,
        model: anthropicPayload.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : "Unknown error",
        content: null,
      },
      Date.now() - startTime,
    )
    throw error
  }
}

// Helper to update tracker model
function updateTrackerModel(trackingId: string | undefined, model: string) {
  if (!trackingId) return
  const request = requestTracker.getRequest(trackingId)
  if (request) request.model = model
}

// Helper to update tracker status
function updateTrackerStatus(
  trackingId: string | undefined,
  status: "executing" | "streaming",
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, { status })
}

// Handle non-streaming response
function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  toolNameMapping: Map<string, string>,
  historyId: string,
  trackingId: string | undefined,
  startTime: number,
) {
  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateToAnthropic(response, toolNameMapping)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )

  recordResponse(
    historyId,
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
    Date.now() - startTime,
  )

  if (trackingId) {
    requestTracker.updateRequest(trackingId, {
      inputTokens: anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens,
    })
  }

  return c.json(anthropicResponse)
}

// Stream accumulator for Anthropic format
interface AnthropicStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  stopReason: string
  content: string
  toolCalls: Array<{ id: string; name: string; input: string }>
  currentToolCall: { id: string; name: string; input: string } | null
}

function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "",
    content: "",
    toolCalls: [],
    currentToolCall: null,
  }
}

// Handle streaming response
async function handleStreamingResponse(
  stream: { writeSSE: (msg: { event: string; data: string }) => Promise<void> },
  response: AsyncIterable<{ data?: string }>,
  toolNameMapping: Map<string, string>,
  anthropicPayload: AnthropicMessagesPayload,
  historyId: string,
  trackingId: string | undefined,
  startTime: number,
) {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  const acc = createAnthropicStreamAccumulator()

  try {
    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      } catch (parseError) {
        consola.error(
          "Failed to parse stream chunk:",
          parseError,
          rawEvent.data,
        )
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

    recordStreamingResponse(acc, anthropicPayload, historyId, startTime)
    completeTracking(trackingId, acc.inputTokens, acc.outputTokens)
  } catch (error) {
    consola.error("Stream error:", error)
    recordStreamingError(acc, anthropicPayload, historyId, startTime, error)
    failTracking(trackingId, error)

    const errorEvent = translateErrorToAnthropicErrorEvent()
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  }
}

// Process a single Anthropic event for accumulation
function processAnthropicEvent(
  event: {
    type: string
    delta?: unknown
    content_block?: unknown
    usage?: unknown
  },
  acc: AnthropicStreamAccumulator,
) {
  switch (event.type) {
    case "content_block_delta": {
      const delta = event.delta as { text?: string; partial_json?: string }
      if (delta.text) acc.content += delta.text
      else if (delta.partial_json && acc.currentToolCall) {
        acc.currentToolCall.input += delta.partial_json
      }
      break
    }
    case "content_block_start": {
      const block = event.content_block as {
        type: string
        id?: string
        name?: string
      }
      if (block.type === "tool_use") {
        acc.currentToolCall = {
          id: block.id || "",
          name: block.name || "",
          input: "",
        }
      }
      break
    }
    case "content_block_stop": {
      if (acc.currentToolCall) {
        acc.toolCalls.push(acc.currentToolCall)
        acc.currentToolCall = null
      }
      break
    }
    case "message_delta": {
      const delta = event.delta as { stop_reason?: string }
      const usage = event.usage as {
        input_tokens?: number
        output_tokens?: number
      }
      if (delta?.stop_reason) acc.stopReason = delta.stop_reason
      if (usage) {
        acc.inputTokens = usage.input_tokens ?? 0
        acc.outputTokens = usage.output_tokens ?? 0
      }
      break
    }
  }
}

// Record streaming response to history
function recordStreamingResponse(
  acc: AnthropicStreamAccumulator,
  payload: AnthropicMessagesPayload,
  historyId: string,
  startTime: number,
) {
  const contentBlocks: Array<{ type: string; text?: string }> = []
  if (acc.content) contentBlocks.push({ type: "text", text: acc.content })
  for (const tc of acc.toolCalls) {
    contentBlocks.push({ type: "tool_use", ...tc })
  }

  recordResponse(
    historyId,
    {
      success: true,
      model: acc.model || payload.model,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      stop_reason: acc.stopReason || undefined,
      content:
        contentBlocks.length > 0 ?
          { role: "assistant", content: contentBlocks }
        : null,
      toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
    },
    Date.now() - startTime,
  )
}

// Record streaming error to history
function recordStreamingError(
  acc: AnthropicStreamAccumulator,
  payload: AnthropicMessagesPayload,
  historyId: string,
  startTime: number,
  error: unknown,
) {
  recordResponse(
    historyId,
    {
      success: false,
      model: acc.model || payload.model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : "Stream error",
      content: null,
    },
    Date.now() - startTime,
  )
}

// Complete TUI tracking
function completeTracking(
  trackingId: string | undefined,
  inputTokens: number,
  outputTokens: number,
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, { inputTokens, outputTokens })
  requestTracker.completeRequest(trackingId, 200, { inputTokens, outputTokens })
}

// Fail TUI tracking
function failTracking(trackingId: string | undefined, error: unknown) {
  if (!trackingId) return
  requestTracker.failRequest(
    trackingId,
    error instanceof Error ? error.message : "Stream error",
  )
}

// Convert Anthropic messages to history MessageContent format
function convertAnthropicMessages(
  messages: AnthropicMessagesPayload["messages"],
): Array<MessageContent> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content }
    }

    // Convert content blocks
    const content = msg.content.map((block) => {
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
      if (block.type === "tool_result") {
        const resultContent =
          typeof block.content === "string" ?
            block.content
          : block.content
              .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("\n")
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: resultContent,
        }
      }
      return { type: block.type }
    })

    return { role: msg.role, content }
  })
}

// Extract system prompt from Anthropic format
function extractSystemPrompt(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n")
}

// Extract tool calls from response content
function extractToolCallsFromContent(
  content: Array<unknown>,
): Array<{ id: string; name: string; input: string }> | undefined {
  const tools: Array<{ id: string; name: string; input: string }> = []
  for (const block of content) {
    if (
      typeof block === "object"
      && block !== null
      && "type" in block
      && block.type === "tool_use"
      && "id" in block
      && "name" in block
      && "input" in block
    ) {
      tools.push({
        id: String(block.id),
        name: String(block.name),
        input: JSON.stringify(block.input),
      })
    }
  }
  return tools.length > 0 ? tools : undefined
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
