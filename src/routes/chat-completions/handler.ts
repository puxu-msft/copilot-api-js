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
      consola.debug("Non-streaming response:", JSON.stringify(response))

      // Record response to history with full content
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
          content:
            choice?.message ?
              {
                role: choice.message.role,
                content:
                  typeof choice.message.content === "string" ?
                    choice.message.content
                  : JSON.stringify(choice.message.content),
                tool_calls: choice.message.tool_calls?.map((tc) => ({
                  id: tc.id,
                  type: tc.type,
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                })),
              }
            : null,
          toolCalls: choice?.message?.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            input: tc.function.arguments,
          })),
        },
        Date.now() - startTime,
      )

      return c.json(response)
    }

    consola.debug("Streaming response")
    return streamSSE(c, async (stream) => {
      // Accumulate stream data for history
      let streamModel = ""
      let streamInputTokens = 0
      let streamOutputTokens = 0
      let streamFinishReason = ""
      let streamContent = ""
      const streamToolCalls: Array<{
        id: string
        name: string
        arguments: string
      }> = []
      const toolCallAccumulators: Map<
        number,
        { id: string; name: string; arguments: string }
      > = new Map()

      try {
        for await (const chunk of response) {
          consola.debug("Streaming chunk:", JSON.stringify(chunk))

          // Parse chunk data for history
          if (chunk.data && chunk.data !== "[DONE]") {
            try {
              const parsed = JSON.parse(chunk.data) as ChatCompletionChunk
              if (parsed.model && !streamModel) {
                streamModel = parsed.model
              }
              if (parsed.usage) {
                streamInputTokens = parsed.usage.prompt_tokens
                streamOutputTokens = parsed.usage.completion_tokens
              }
              const choice = parsed.choices[0]
              if (choice?.delta?.content) {
                streamContent += choice.delta.content
              }
              if (choice?.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const idx = tc.index
                  if (!toolCallAccumulators.has(idx)) {
                    toolCallAccumulators.set(idx, {
                      id: tc.id || "",
                      name: tc.function?.name || "",
                      arguments: "",
                    })
                  }
                  const acc = toolCallAccumulators.get(idx)
                  if (acc) {
                    if (tc.id) acc.id = tc.id
                    if (tc.function?.name) acc.name = tc.function.name
                    if (tc.function?.arguments)
                      acc.arguments += tc.function.arguments
                  }
                }
              }
              if (choice?.finish_reason) {
                streamFinishReason = choice.finish_reason
              }
            } catch {
              // Ignore parse errors for history
            }
          }

          await stream.writeSSE(chunk as SSEMessage)
        }

        // Collect accumulated tool calls
        for (const tc of toolCallAccumulators.values()) {
          if (tc.id && tc.name) {
            streamToolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })
          }
        }

        // Build content for history
        const toolCallsForContent = streamToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))

        // Record streaming response to history with full content
        recordResponse(
          historyId,
          {
            success: true,
            model: streamModel || payload.model,
            usage: {
              input_tokens: streamInputTokens,
              output_tokens: streamOutputTokens,
            },
            stop_reason: streamFinishReason || undefined,
            content: {
              role: "assistant",
              content: streamContent || undefined,
              tool_calls:
                toolCallsForContent.length > 0 ?
                  toolCallsForContent
                : undefined,
            },
            toolCalls:
              streamToolCalls.length > 0 ?
                streamToolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  input: tc.arguments,
                }))
              : undefined,
          },
          Date.now() - startTime,
        )
      } catch (error) {
        // Record error to history
        recordResponse(
          historyId,
          {
            success: false,
            model: streamModel || payload.model,
            usage: { input_tokens: 0, output_tokens: 0 },
            error: error instanceof Error ? error.message : "Stream error",
            content: null,
          },
          Date.now() - startTime,
        )
        throw error
      }
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
