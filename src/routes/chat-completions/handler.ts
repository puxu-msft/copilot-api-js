import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { recordRequest, recordResponse } from "~/lib/history"
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

  // Record request to history
  const historyId = recordRequest("openai", {
    model: payload.model,
    messageCount: payload.messages.length,
    stream: payload.stream ?? false,
    hasTools: Boolean(payload.tools?.length),
    toolCount: payload.tools?.length ?? undefined,
    max_tokens: payload.max_tokens ?? undefined,
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

      // Record response to history
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
          contentSummary:
            typeof choice?.message?.content === "string"
              ? choice.message.content.slice(0, 200)
              : "",
          toolCalls: choice?.message?.tool_calls?.map((tc) => tc.function.name),
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
      const streamToolCalls: string[] = []

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
                  if (tc.function?.name) {
                    streamToolCalls.push(tc.function.name)
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

        // Record streaming response to history
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
            contentSummary: streamContent.slice(0, 200),
            toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
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
            contentSummary: "",
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
        contentSummary: "",
      },
      Date.now() - startTime,
    )
    throw error
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
