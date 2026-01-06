import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import {
  isHistoryEnabled,
  recordRequest,
  recordResponse,
} from "~/lib/history"
import { executeWithRateLimit } from "~/lib/queue"
import { state } from "~/lib/state"
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
  type ToolNameMapping,
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

  // Record request to history
  const historyId = recordRequest("anthropic", {
    model: anthropicPayload.model,
    messageCount: anthropicPayload.messages.length,
    stream: anthropicPayload.stream ?? false,
    hasTools: Boolean(anthropicPayload.tools?.length),
    toolCount: anthropicPayload.tools?.length,
    max_tokens: anthropicPayload.max_tokens,
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
      consola.debug(
        "Non-streaming response from Copilot:",
        JSON.stringify(response).slice(-400),
      )
      const anthropicResponse = translateToAnthropic(response, toolNameMapping)
      consola.debug(
        "Translated Anthropic response:",
        JSON.stringify(anthropicResponse),
      )

      // Record response to history
      recordResponse(
        historyId,
        {
          success: true,
          model: anthropicResponse.model,
          usage: anthropicResponse.usage,
          stop_reason: anthropicResponse.stop_reason ?? undefined,
          contentSummary: extractContentSummary(anthropicResponse.content),
          toolCalls: extractToolCalls(anthropicResponse.content),
        },
        Date.now() - startTime,
      )

      return c.json(anthropicResponse)
    }

    consola.debug("Streaming response from Copilot")
    return streamSSE(c, async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
      }

      // Accumulate stream data for history
      let streamModel = ""
      let streamInputTokens = 0
      let streamOutputTokens = 0
      let streamStopReason = ""
      let streamContent = ""
      const streamToolCalls: string[] = []

      try {
        for await (const rawEvent of response) {
          consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
          if (rawEvent.data === "[DONE]") {
            break
          }

          if (!rawEvent.data) {
            continue
          }

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

          // Capture model from chunk
          if (chunk.model && !streamModel) {
            streamModel = chunk.model
          }

          const events = translateChunkToAnthropicEvents(
            chunk,
            streamState,
            toolNameMapping,
          )

          for (const event of events) {
            consola.debug("Translated Anthropic event:", JSON.stringify(event))

            // Capture data for history
            if (event.type === "content_block_delta") {
              if ("text" in event.delta) {
                streamContent += event.delta.text
              }
            } else if (event.type === "content_block_start") {
              if (event.content_block.type === "tool_use") {
                streamToolCalls.push(event.content_block.name)
              }
            } else if (event.type === "message_delta") {
              if (event.delta.stop_reason) {
                streamStopReason = event.delta.stop_reason
              }
              if (event.usage) {
                streamInputTokens = event.usage.input_tokens ?? 0
                streamOutputTokens = event.usage.output_tokens
              }
            }

            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }

        // Record streaming response to history
        recordResponse(
          historyId,
          {
            success: true,
            model: streamModel || anthropicPayload.model,
            usage: {
              input_tokens: streamInputTokens,
              output_tokens: streamOutputTokens,
            },
            stop_reason: streamStopReason || undefined,
            contentSummary: streamContent.slice(0, 200),
            toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
          },
          Date.now() - startTime,
        )
      } catch (error) {
        consola.error("Stream error:", error)

        // Record error to history
        recordResponse(
          historyId,
          {
            success: false,
            model: streamModel || anthropicPayload.model,
            usage: { input_tokens: 0, output_tokens: 0 },
            error: error instanceof Error ? error.message : "Stream error",
            contentSummary: "",
          },
          Date.now() - startTime,
        )

        const errorEvent = translateErrorToAnthropicErrorEvent()
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  } catch (error) {
    // Record error to history
    recordResponse(
      historyId,
      {
        success: false,
        model: anthropicPayload.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: error instanceof Error ? error.message : "Unknown error",
        contentSummary: "",
      },
      Date.now() - startTime,
    )
    throw error
  }
}

function extractContentSummary(content: unknown[]): string {
  for (const block of content) {
    if (
      typeof block === "object"
      && block !== null
      && "type" in block
      && block.type === "text"
      && "text" in block
    ) {
      return String(block.text).slice(0, 200)
    }
  }
  return ""
}

function extractToolCalls(content: unknown[]): string[] | undefined {
  const tools: string[] = []
  for (const block of content) {
    if (
      typeof block === "object"
      && block !== null
      && "type" in block
      && block.type === "tool_use"
      && "name" in block
    ) {
      tools.push(String(block.name))
    }
  }
  return tools.length > 0 ? tools : undefined
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
