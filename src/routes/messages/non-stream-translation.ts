import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import consola from "consola"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Helper function to fix message sequences by adding missing tool responses
// This prevents "tool_use ids were found without tool_result blocks" errors
function fixMessageSequence(messages: Array<Message>): Array<Message> {
  const fixedMessages: Array<Message> = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    fixedMessages.push(message)

    if (
      message.role === "assistant"
      && message.tool_calls
      && message.tool_calls.length > 0
    ) {
      // Find which tool calls already have responses
      const foundToolResponses = new Set<string>()

      // Look ahead to see what tool responses exist
      let j = i + 1
      while (j < messages.length && messages[j].role === "tool") {
        const toolMessage = messages[j]
        if (toolMessage.tool_call_id) {
          foundToolResponses.add(toolMessage.tool_call_id)
        }
        j++
      }

      // Add placeholder responses for missing tool calls
      for (const toolCall of message.tool_calls) {
        if (!foundToolResponses.has(toolCall.id)) {
          consola.debug(`Adding placeholder tool_result for ${toolCall.id}`)
          fixedMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Tool execution was interrupted or failed.",
          })
        }
      }
    }
  }

  return fixedMessages
}

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const messages = translateAnthropicMessagesToOpenAI(
    payload.messages,
    payload.system,
  )

  return {
    model: translateModelName(payload.model),
    // Fix message sequence to ensure all tool_use blocks have corresponding tool_result
    messages: fixMessageSequence(messages),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  }
}

function translateModelName(model: string): string {
  // Handle short model name aliases (e.g., "opus", "sonnet", "haiku")
  // Maps to the latest available version in Copilot
  const shortNameMap: Record<string, string> = {
    opus: "claude-opus-4.5",
    sonnet: "claude-sonnet-4.5",
    haiku: "claude-haiku-4.5",
  }

  if (shortNameMap[model]) {
    return shortNameMap[model]
  }

  // Handle versioned model names from Anthropic API (e.g., claude-sonnet-4-20250514)
  // Strip date suffixes and convert to Copilot-compatible format

  // claude-sonnet-4-5-YYYYMMDD -> claude-sonnet-4.5
  if (model.match(/^claude-sonnet-4-5-\d+$/)) {
    return "claude-sonnet-4.5"
  }
  // claude-sonnet-4-YYYYMMDD -> claude-sonnet-4
  if (model.match(/^claude-sonnet-4-\d+$/)) {
    return "claude-sonnet-4"
  }

  // claude-opus-4-5-YYYYMMDD -> claude-opus-4.5
  if (model.match(/^claude-opus-4-5-\d+$/)) {
    return "claude-opus-4.5"
  }
  // claude-opus-4-YYYYMMDD -> claude-opus-4.5 (default to latest)
  if (model.match(/^claude-opus-4-\d+$/)) {
    return "claude-opus-4.5"
  }

  // claude-haiku-4-5-YYYYMMDD -> claude-haiku-4.5
  if (model.match(/^claude-haiku-4-5-\d+$/)) {
    return "claude-haiku-4.5"
  }
  // claude-haiku-3-5-YYYYMMDD -> claude-haiku-4.5 (upgrade to latest available)
  if (model.match(/^claude-haiku-3-5-\d+$/)) {
    return "claude-haiku-4.5"
  }

  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Handle edge case of empty choices array
  if (response.choices.length === 0) {
    return {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    }
  }

  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    } catch (error) {
      consola.warn(
        `Failed to parse tool call arguments for ${toolCall.function.name}:`,
        error,
      )
    }
    return {
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input,
    }
  })
}
