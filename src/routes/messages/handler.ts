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
      consola.debug(
        "Non-streaming response from Copilot:",
        JSON.stringify(response).slice(-400),
      )
      const anthropicResponse = translateToAnthropic(response, toolNameMapping)
      consola.debug(
        "Translated Anthropic response:",
        JSON.stringify(anthropicResponse),
      )

      // Record response to history with full content
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
      const streamToolCalls: Array<{
        id: string
        name: string
        input: string
      }> = []
      let currentToolCall: { id: string; name: string; input: string } | null =
        null

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
            switch (event.type) {
              case "content_block_delta": {
                if ("text" in event.delta) {
                  streamContent += event.delta.text
                } else if ("partial_json" in event.delta && currentToolCall) {
                  currentToolCall.input += event.delta.partial_json
                }

                break
              }
              case "content_block_start": {
                if (event.content_block.type === "tool_use") {
                  currentToolCall = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    input: "",
                  }
                }

                break
              }
              case "content_block_stop": {
                if (currentToolCall) {
                  streamToolCalls.push(currentToolCall)
                  currentToolCall = null
                }

                break
              }
              case "message_delta": {
                if (event.delta.stop_reason) {
                  streamStopReason = event.delta.stop_reason
                }
                if (event.usage) {
                  streamInputTokens = event.usage.input_tokens ?? 0
                  streamOutputTokens = event.usage.output_tokens
                }

                break
              }
              // No default
            }

            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }

        // Record streaming response to history with full content
        const contentBlocks: Array<{ type: string; text?: string }> = []
        if (streamContent) {
          contentBlocks.push({ type: "text", text: streamContent })
        }
        for (const tc of streamToolCalls) {
          contentBlocks.push({
            type: "tool_use",
            ...tc,
          })
        }

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
            content:
              contentBlocks.length > 0 ?
                { role: "assistant", content: contentBlocks }
              : null,
            toolCalls:
              streamToolCalls.length > 0 ?
                streamToolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  input: tc.input,
                }))
              : undefined,
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
            content: null,
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
        content: null,
      },
      Date.now() - startTime,
    )
    throw error
  }
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
