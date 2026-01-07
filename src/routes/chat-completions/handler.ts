/* eslint-disable max-params, complexity, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion */
import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  type MessageContent,
  recordRequest,
  recordResponse,
} from "~/lib/history"
import { executeWithRateLimit } from "~/lib/queue"
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

export async function handleCompletion(c: Context) {
  const startTime = Date.now()
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Update TUI tracker with model info
  const trackingId = c.get("trackingId") as string | undefined
  updateTrackerModel(trackingId, payload.model)

  // Record request to history with full messages
  const historyId = recordRequest("openai", {
    model: payload.model,
    messages: convertOpenAIMessages(payload.messages),
    stream: payload.stream ?? false,
    tools: payload.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
    })),
    max_tokens: payload.max_tokens ?? undefined,
    temperature: payload.temperature ?? undefined,
  })

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  try {
    // Use queue-based rate limiting
    const response = await executeWithRateLimit(state, () =>
      createChatCompletions(payload),
    )

    if (isNonStreaming(response)) {
      return handleNonStreamingResponse(
        c,
        response,
        historyId,
        trackingId,
        startTime,
      )
    }

    consola.debug("Streaming response")
    updateTrackerStatus(trackingId, "streaming")

    return streamSSE(c, async (stream) => {
      await handleStreamingResponse(
        stream,
        response,
        payload,
        historyId,
        trackingId,
        startTime,
      )
    })
  } catch (error) {
    // Record error to history
    recordResponse(
      historyId,
      {
        success: false,
        model: payload.model,
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
  historyId: string,
  trackingId: string | undefined,
  startTime: number,
) {
  consola.debug("Non-streaming response:", JSON.stringify(response))

  const choice = response.choices[0]
  recordResponse(
    historyId,
    {
      success: true,
      model: response.model,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      stop_reason: choice?.finish_reason ?? undefined,
      content: buildResponseContent(choice),
      toolCalls: extractToolCalls(choice),
    },
    Date.now() - startTime,
  )

  // Update TUI tracker with token usage
  if (trackingId && response.usage) {
    requestTracker.updateRequest(trackingId, {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    })
  }

  return c.json(response)
}

// Build response content for history
function buildResponseContent(choice: ChatCompletionResponse["choices"][0]) {
  if (!choice?.message) return null
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
  return choice?.message?.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: tc.function.arguments,
  }))
}

// Handle streaming response
async function handleStreamingResponse(
  stream: { writeSSE: (msg: SSEMessage) => Promise<void> },
  response: AsyncIterable<{ data?: string; event?: string }>,
  payload: ChatCompletionsPayload,
  historyId: string,
  trackingId: string | undefined,
  startTime: number,
) {
  const accumulator = createStreamAccumulator()

  try {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      parseStreamChunk(chunk, accumulator)
      await stream.writeSSE(chunk as SSEMessage)
    }

    const {
      model,
      inputTokens,
      outputTokens,
      content,
      toolCalls,
      finishReason,
    } = finalizeAccumulator(accumulator, payload.model)

    recordResponse(
      historyId,
      {
        success: true,
        model,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        stop_reason: finishReason || undefined,
        content: {
          role: "assistant",
          content: content || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        toolCalls:
          accumulator.toolCalls.length > 0 ?
            accumulator.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            }))
          : undefined,
      },
      Date.now() - startTime,
    )

    if (trackingId) {
      requestTracker.updateRequest(trackingId, { inputTokens, outputTokens })
      requestTracker.completeRequest(trackingId, 200, {
        inputTokens,
        outputTokens,
      })
    }
  } catch (error) {
    recordResponse(
      historyId,
      {
        success: false,
        model: accumulator.model || payload.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : "Stream error",
        content: null,
      },
      Date.now() - startTime,
    )
    if (trackingId) {
      requestTracker.failRequest(
        trackingId,
        error instanceof Error ? error.message : "Stream error",
      )
    }
    throw error
  }
}

// Stream accumulator type
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

function parseStreamChunk(chunk: { data?: string }, acc: StreamAccumulator) {
  if (!chunk.data || chunk.data === "[DONE]") return

  try {
    const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
    if (parsed.model && !acc.model) acc.model = parsed.model
    if (parsed.usage) {
      acc.inputTokens = parsed.usage.prompt_tokens
      acc.outputTokens = parsed.usage.completion_tokens
    }
    const choice = parsed.choices[0]
    if (choice?.delta?.content) acc.content += choice.delta.content
    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index
        if (!acc.toolCallMap.has(idx)) {
          acc.toolCallMap.set(idx, {
            id: tc.id || "",
            name: tc.function?.name || "",
            arguments: "",
          })
        }
        const item = acc.toolCallMap.get(idx)!
        if (tc.id) item.id = tc.id
        if (tc.function?.name) item.name = tc.function.name
        if (tc.function?.arguments) item.arguments += tc.function.arguments
      }
    }
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason
  } catch {
    // Ignore parse errors
  }
}

function finalizeAccumulator(acc: StreamAccumulator, fallbackModel: string) {
  // Collect tool calls
  for (const tc of acc.toolCallMap.values()) {
    if (tc.id && tc.name) acc.toolCalls.push(tc)
  }
  const toolCalls = acc.toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }))
  return {
    model: acc.model || fallbackModel,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    content: acc.content,
    toolCalls,
    finishReason: acc.finishReason,
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

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
