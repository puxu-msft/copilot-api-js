import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { awaitApproval } from "~/lib/approval"
import { createCompactionMarker } from "~/lib/auto-compact"
import { HTTPError } from "~/lib/error"
import {
  type MessageContent,
  recordRequest,
  recordResponse,
} from "~/lib/history"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { requestTracker } from "~/lib/tui"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
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
  updateTrackerModel,
  updateTrackerStatus,
} from "../shared"

export async function handleCompletion(c: Context) {
  const originalPayload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(originalPayload).slice(-400))

  // Get tracking ID and use tracker's startTime for consistent timing
  const trackingId = c.get("trackingId") as string | undefined
  const trackedRequest =
    trackingId ? requestTracker.getRequest(trackingId) : undefined
  const startTime = trackedRequest?.startTime ?? Date.now()

  // Update TUI tracker with model info
  updateTrackerModel(trackingId, originalPayload.model)

  // Record request to history with full messages
  const historyId = recordRequest("openai", {
    model: originalPayload.model,
    messages: convertOpenAIMessages(originalPayload.messages),
    stream: originalPayload.stream ?? false,
    tools: originalPayload.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
    })),
    max_tokens: originalPayload.max_tokens ?? undefined,
    temperature: originalPayload.temperature ?? undefined,
  })

  const ctx: ResponseContext = { historyId, trackingId, startTime }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === originalPayload.model,
  )

  // Calculate and display token count
  await logTokenCount(originalPayload, selectedModel)

  // Build the final payload with potential auto-compact and max_tokens
  const { finalPayload, compactResult } = await buildFinalPayload(
    originalPayload,
    selectedModel,
  )
  if (compactResult) {
    ctx.compactResult = compactResult
  }

  const payload =
    isNullish(finalPayload.max_tokens) ?
      {
        ...finalPayload,
        max_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
      }
    : finalPayload

  if (isNullish(originalPayload.max_tokens)) {
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  if (state.manualApprove) await awaitApproval()

  // Execute request with error handling
  return executeRequest({
    c,
    payload,
    selectedModel,
    ctx,
    trackingId,
  })
}

/** Options for executeRequest */
interface ExecuteRequestOptions {
  c: Context
  payload: ChatCompletionsPayload
  selectedModel: Model | undefined
  ctx: ResponseContext
  trackingId: string | undefined
}

/**
 * Execute the API call with enhanced error handling for 413 errors.
 */
async function executeRequest(opts: ExecuteRequestOptions) {
  const { c, payload, selectedModel, ctx, trackingId } = opts

  try {
    const { result: response, queueWaitMs } =
      await executeWithAdaptiveRateLimit(() => createChatCompletions(payload))

    // Store queueWaitMs in context for later use
    ctx.queueWaitMs = queueWaitMs

    if (isNonStreaming(response)) {
      return handleNonStreamingResponse(c, response, ctx)
    }

    consola.debug("Streaming response")
    updateTrackerStatus(trackingId, "streaming")

    return streamSSE(c, async (stream) => {
      await handleStreamingResponse({ stream, response, payload, ctx })
    })
  } catch (error) {
    // Handle 413 Request Entity Too Large with helpful debugging info
    if (error instanceof HTTPError && error.status === 413) {
      await logPayloadSizeInfo(payload, selectedModel)
    }

    recordErrorResponse(ctx, payload.model, error)
    throw error
  }
}

// Log token count for debugging
async function logTokenCount(
  payload: ChatCompletionsPayload,
  selectedModel: { id: string } | undefined,
) {
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(
        payload,
        selectedModel as Parameters<typeof getTokenCount>[1],
      )
      consola.debug("Current token count:", tokenCount)
    } else {
      consola.debug("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.debug("Failed to calculate token count:", error)
  }
}

// Handle non-streaming response
function handleNonStreamingResponse(
  c: Context,
  originalResponse: ChatCompletionResponse,
  ctx: ResponseContext,
) {
  consola.debug("Non-streaming response:", JSON.stringify(originalResponse))

  // Append compaction marker if auto-compact was performed
  let response = originalResponse
  if (ctx.compactResult?.wasCompacted && response.choices[0]?.message.content) {
    const marker = createCompactionMarker(ctx.compactResult)
    response = {
      ...response,
      choices: response.choices.map((choice, i) =>
        i === 0 ?
          {
            ...choice,
            message: {
              ...choice.message,
              content: (choice.message.content ?? "") + marker,
            },
          }
        : choice,
      ),
    }
  }

  const choice = response.choices[0]
  const usage = response.usage

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: response.model,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
      stop_reason: choice.finish_reason,
      content: buildResponseContent(choice),
      toolCalls: extractToolCalls(choice),
    },
    Date.now() - ctx.startTime,
  )

  if (ctx.trackingId && usage) {
    requestTracker.updateRequest(ctx.trackingId, {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      queueWaitMs: ctx.queueWaitMs,
    })
  }

  return c.json(response)
}

// Build response content for history
function buildResponseContent(choice: ChatCompletionResponse["choices"][0]) {
  return {
    role: choice.message.role,
    content:
      typeof choice.message.content === "string" ?
        choice.message.content
      : JSON.stringify(choice.message.content),
    tool_calls: choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })),
  }
}

// Extract tool calls for history
function extractToolCalls(choice: ChatCompletionResponse["choices"][0]) {
  return choice.message.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: tc.function.arguments,
  }))
}

/** Stream accumulator for collecting streaming response data */
interface StreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  finishReason: string
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  toolCallMap: Map<number, { id: string; name: string; arguments: string }>
}

function createStreamAccumulator(): StreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    finishReason: "",
    content: "",
    toolCalls: [],
    toolCallMap: new Map(),
  }
}

/** Options for handleStreamingResponse */
interface StreamingOptions {
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> }
  response: AsyncIterable<{ data?: string; event?: string }>
  payload: ChatCompletionsPayload
  ctx: ResponseContext
}

// Handle streaming response
async function handleStreamingResponse(opts: StreamingOptions) {
  const { stream, response, payload, ctx } = opts
  const acc = createStreamAccumulator()

  try {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      parseStreamChunk(chunk, acc)
      await stream.writeSSE(chunk as SSEMessage)
    }

    // Append compaction marker as final chunk if auto-compact was performed
    if (ctx.compactResult?.wasCompacted) {
      const marker = createCompactionMarker(ctx.compactResult)
      const markerChunk: ChatCompletionChunk = {
        id: `compact-marker-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: acc.model || payload.model,
        choices: [
          {
            index: 0,
            delta: { content: marker },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }
      await stream.writeSSE({
        data: JSON.stringify(markerChunk),
        event: "message",
      })
      acc.content += marker
    }

    recordStreamSuccess(acc, payload.model, ctx)
    completeTracking(
      ctx.trackingId,
      acc.inputTokens,
      acc.outputTokens,
      ctx.queueWaitMs,
    )
  } catch (error) {
    recordStreamError({ acc, fallbackModel: payload.model, ctx, error })
    failTracking(ctx.trackingId, error)
    throw error
  }
}

// Parse a single stream chunk and accumulate data
function parseStreamChunk(chunk: { data?: string }, acc: StreamAccumulator) {
  if (!chunk.data || chunk.data === "[DONE]") return

  try {
    const parsed = JSON.parse(chunk.data) as ChatCompletionChunk

    // Accumulate model
    if (parsed.model && !acc.model) acc.model = parsed.model

    // Accumulate usage
    if (parsed.usage) {
      acc.inputTokens = parsed.usage.prompt_tokens
      acc.outputTokens = parsed.usage.completion_tokens
    }

    // Accumulate choice
    const choice = parsed.choices[0] as (typeof parsed.choices)[0] | undefined
    if (choice) {
      if (choice.delta.content) acc.content += choice.delta.content
      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index
          if (!acc.toolCallMap.has(idx)) {
            acc.toolCallMap.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            })
          }
          const item = acc.toolCallMap.get(idx)
          if (item) {
            if (tc.id) item.id = tc.id
            if (tc.function?.name) item.name = tc.function.name
            if (tc.function?.arguments) item.arguments += tc.function.arguments
          }
        }
      }
      if (choice.finish_reason) acc.finishReason = choice.finish_reason
    }
  } catch {
    // Ignore parse errors
  }
}

// Record successful streaming response
function recordStreamSuccess(
  acc: StreamAccumulator,
  fallbackModel: string,
  ctx: ResponseContext,
) {
  // Collect tool calls from map
  for (const tc of acc.toolCallMap.values()) {
    if (tc.id && tc.name) acc.toolCalls.push(tc)
  }

  const toolCalls = acc.toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }))

  recordResponse(
    ctx.historyId,
    {
      success: true,
      model: acc.model || fallbackModel,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      stop_reason: acc.finishReason || undefined,
      content: {
        role: "assistant",
        content: acc.content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls:
        acc.toolCalls.length > 0 ?
          acc.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          }))
        : undefined,
    },
    Date.now() - ctx.startTime,
  )
}

// Convert OpenAI messages to history MessageContent format
function convertOpenAIMessages(
  messages: ChatCompletionsPayload["messages"],
): Array<MessageContent> {
  return messages.map((msg) => {
    const result: MessageContent = {
      role: msg.role,
      content:
        typeof msg.content === "string" ?
          msg.content
        : JSON.stringify(msg.content),
    }

    // Handle tool calls in assistant messages
    if ("tool_calls" in msg && msg.tool_calls) {
      result.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }))
    }

    // Handle tool result messages
    if ("tool_call_id" in msg && msg.tool_call_id) {
      result.tool_call_id = msg.tool_call_id
    }

    // Handle function name
    if ("name" in msg && msg.name) {
      result.name = msg.name
    }

    return result
  })
}
