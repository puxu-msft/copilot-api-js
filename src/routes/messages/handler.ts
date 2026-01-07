import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  autoCompact,
  checkNeedsCompaction,
  createCompactionMarker,
  type AutoCompactResult,
} from "~/lib/auto-compact"
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
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type AnthropicStreamEventData,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
  type ToolNameMapping,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

/** Context for recording responses and tracking */
interface ResponseContext {
  historyId: string
  trackingId: string | undefined
  startTime: number
  compactResult?: AutoCompactResult
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Get tracking ID and use tracker's startTime for consistent timing
  const trackingId = c.get("trackingId") as string | undefined
  const trackedRequest =
    trackingId ? requestTracker.getRequest(trackingId) : undefined
  const startTime = trackedRequest?.startTime ?? Date.now()

  // Update TUI tracker with model info
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

  const ctx: ResponseContext = { historyId, trackingId, startTime }

  const { payload: translatedPayload, toolNameMapping } =
    translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(translatedPayload),
  )

  // Auto-compact if enabled and needed
  const selectedModel = state.models?.data.find(
    (model) => model.id === translatedPayload.model,
  )

  const { finalPayload: openAIPayload, compactResult } =
    await buildFinalPayload(translatedPayload, selectedModel)
  if (compactResult) {
    ctx.compactResult = compactResult
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  try {
    const response = await executeWithRateLimit(state, () =>
      createChatCompletions(openAIPayload),
    )

    if (isNonStreaming(response)) {
      return handleNonStreamingResponse({ c, response, toolNameMapping, ctx })
    }

    consola.debug("Streaming response from Copilot")
    updateTrackerStatus(trackingId, "streaming")

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
    recordErrorResponse(ctx, anthropicPayload.model, error)
    throw error
  }
}

// Helper to update tracker model
function updateTrackerModel(trackingId: string | undefined, model: string) {
  if (!trackingId) return
  const request = requestTracker.getRequest(trackingId)
  if (request) request.model = model
}

// Build final payload with auto-compact if needed
async function buildFinalPayload(
  payload: ChatCompletionsPayload,
  model: Parameters<typeof checkNeedsCompaction>[1] | undefined,
): Promise<{
  finalPayload: ChatCompletionsPayload
  compactResult: AutoCompactResult | null
}> {
  if (!state.autoCompact || !model) {
    if (state.autoCompact && !model) {
      consola.warn(
        `Auto-compact: Model '${payload.model}' not found in cached models, skipping`,
      )
    }
    return { finalPayload: payload, compactResult: null }
  }

  try {
    const check = await checkNeedsCompaction(payload, model)
    consola.debug(
      `Auto-compact check: ${check.currentTokens} tokens, limit ${check.limit}, needed: ${check.needed}`,
    )
    if (!check.needed) {
      return { finalPayload: payload, compactResult: null }
    }

    consola.info(
      `Auto-compact triggered: ${check.currentTokens} tokens > ${check.limit} limit`,
    )
    const compactResult = await autoCompact(payload, model)
    return { finalPayload: compactResult.payload, compactResult }
  } catch (error) {
    consola.warn(
      "Auto-compact failed, proceeding with original payload:",
      error,
    )
    return { finalPayload: payload, compactResult: null }
  }
}

// Helper to update tracker status
function updateTrackerStatus(
  trackingId: string | undefined,
  status: "executing" | "streaming",
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, { status })
}

// Record error response to history
function recordErrorResponse(
  ctx: ResponseContext,
  model: string,
  error: unknown,
) {
  recordResponse(
    ctx.historyId,
    {
      success: false,
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : "Unknown error",
      content: null,
    },
    Date.now() - ctx.startTime,
  )
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

  // Append compaction marker if auto-compact was performed
  if (ctx.compactResult?.wasCompacted) {
    const marker = createCompactionMarker(ctx.compactResult)
    anthropicResponse = appendMarkerToAnthropicResponse(
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
    })
  }

  return c.json(anthropicResponse)
}

// Append marker to Anthropic response content
function appendMarkerToAnthropicResponse(
  response: ReturnType<typeof translateToAnthropic>,
  marker: string,
): ReturnType<typeof translateToAnthropic> {
  // Find last text block and append, or add new text block
  const content = [...response.content]
  const lastTextIndex = content.findLastIndex((block) => block.type === "text")

  if (lastTextIndex !== -1) {
    const textBlock = content[lastTextIndex]
    if (textBlock.type === "text") {
      content[lastTextIndex] = {
        ...textBlock,
        text: textBlock.text + marker,
      }
    }
  } else {
    // No text block found, add one
    content.push({ type: "text", text: marker })
  }

  return { ...response, content }
}

/** Stream accumulator for Anthropic format */
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
    await processStreamChunks({
      stream,
      response,
      toolNameMapping,
      streamState,
      acc,
    })

    // Append compaction marker as final content block if auto-compact was performed
    if (ctx.compactResult?.wasCompacted) {
      const marker = createCompactionMarker(ctx.compactResult)
      await sendCompactionMarkerEvent(stream, streamState, marker)
      acc.content += marker
    }

    recordStreamingResponse(acc, anthropicPayload.model, ctx)
    completeTracking(ctx.trackingId, acc.inputTokens, acc.outputTokens)
  } catch (error) {
    consola.error("Stream error:", error)
    recordStreamingError({
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

// Send compaction marker as Anthropic SSE events
async function sendCompactionMarkerEvent(
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

// Process a single Anthropic event for accumulation
function processAnthropicEvent(
  event: AnthropicStreamEventData,
  acc: AnthropicStreamAccumulator,
) {
  switch (event.type) {
    case "content_block_delta": {
      handleContentBlockDelta(event.delta, acc)
      break
    }
    case "content_block_start": {
      handleContentBlockStart(event.content_block, acc)
      break
    }
    case "content_block_stop": {
      handleContentBlockStop(acc)
      break
    }
    case "message_delta": {
      handleMessageDelta(event.delta, event.usage, acc)
      break
    }
    default: {
      break
    }
  }
}

// Content block delta types
type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

function handleContentBlockDelta(
  delta: ContentBlockDelta,
  acc: AnthropicStreamAccumulator,
) {
  if (delta.type === "text_delta") {
    acc.content += delta.text
  } else if (delta.type === "input_json_delta" && acc.currentToolCall) {
    acc.currentToolCall.input += delta.partial_json
  }
  // thinking_delta and signature_delta are ignored for accumulation
}

// Content block types from anthropic-types.ts
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use"
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: "thinking"; thinking: string }

function handleContentBlockStart(
  block: ContentBlock,
  acc: AnthropicStreamAccumulator,
) {
  if (block.type === "tool_use") {
    acc.currentToolCall = {
      id: block.id,
      name: block.name,
      input: "",
    }
  }
}

function handleContentBlockStop(acc: AnthropicStreamAccumulator) {
  if (acc.currentToolCall) {
    acc.toolCalls.push(acc.currentToolCall)
    acc.currentToolCall = null
  }
}

// Message delta types
interface MessageDelta {
  stop_reason?: string | null
  stop_sequence?: string | null
}

interface MessageUsage {
  input_tokens?: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function handleMessageDelta(
  delta: MessageDelta,
  usage: MessageUsage | undefined,
  acc: AnthropicStreamAccumulator,
) {
  if (delta.stop_reason) acc.stopReason = delta.stop_reason
  if (usage) {
    acc.inputTokens = usage.input_tokens ?? 0
    acc.outputTokens = usage.output_tokens
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

// Record streaming error to history
function recordStreamingError(opts: {
  acc: AnthropicStreamAccumulator
  fallbackModel: string
  ctx: ResponseContext
  error: unknown
}) {
  const { acc, fallbackModel, ctx, error } = opts
  recordResponse(
    ctx.historyId,
    {
      success: false,
      model: acc.model || fallbackModel,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : "Stream error",
      content: null,
    },
    Date.now() - ctx.startTime,
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
