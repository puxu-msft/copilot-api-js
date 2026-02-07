import consola from "consola"

import { mapOpenAIStopReasonToAnthropic } from "~/lib/anthropic/message-utils"
import { translateModelName } from "~/lib/model-resolver"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"
import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "~/types/api/anthropic"

// OpenAI limits function names to 64 characters
const OPENAI_TOOL_NAME_LIMIT = 64

// Mapping from truncated tool names to original names
// This is used to restore original names in responses
export interface ToolNameMapping {
  truncatedToOriginal: Map<string, string>
  originalToTruncated: Map<string, string>
}

/**
 * Ensure all tool_use blocks have corresponding tool_result responses,
 * while maintaining the originMap in sync with any inserted messages.
 */
function fixMessageSequenceWithOriginMap(
  messages: Array<Message>,
  originMap: Array<number>,
): { messages: Array<Message>; originMap: Array<number> } {
  const fixedMessages: Array<Message> = []
  const fixedOriginMap: Array<number> = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    fixedMessages.push(message)
    fixedOriginMap.push(originMap[i])

    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
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
          // Injected placeholder — use -1 to indicate no original source
          fixedOriginMap.push(-1)
        }
      }
    }
  }

  return { messages: fixedMessages, originMap: fixedOriginMap }
}

// Payload translation

export interface TranslationResult {
  payload: ChatCompletionsPayload
  toolNameMapping: ToolNameMapping
  /** Maps each OpenAI message index to its source Anthropic message index (-1 for system/injected) */
  originMap: Array<number>
}

export function translateToOpenAI(payload: AnthropicMessagesPayload): TranslationResult {
  // Create tool name mapping for this request
  const toolNameMapping: ToolNameMapping = {
    truncatedToOriginal: new Map(),
    originalToTruncated: new Map(),
  }

  const { messages, originMap: rawOriginMap } = translateAnthropicMessagesToOpenAI(
    payload.messages,
    payload.system,
    toolNameMapping,
  )

  // fixMessageSequence may insert placeholder tool messages
  const { messages: fixedMessages, originMap } = fixMessageSequenceWithOriginMap(messages, rawOriginMap)

  return {
    payload: {
      model: translateModelName(payload.model),
      messages: fixedMessages,
      max_tokens: payload.max_tokens,
      stop: payload.stop_sequences,
      stream: payload.stream,
      temperature: payload.temperature,
      top_p: payload.top_p,
      user: payload.metadata?.user_id,
      tools: translateAnthropicToolsToOpenAI(payload.tools, toolNameMapping),
      tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice, toolNameMapping),
    },
    toolNameMapping,
    originMap,
  }
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
  toolNameMapping: ToolNameMapping,
): { messages: Array<Message>; originMap: Array<number> } {
  const systemMessages = handleSystemPrompt(system)
  const originMap: Array<number> = systemMessages.map(() => -1)

  const otherMessages: Array<Message> = []
  for (const [i, message] of anthropicMessages.entries()) {
    const translated =
      message.role === "user" ? handleUserMessage(message) : handleAssistantMessage(message, toolNameMapping)
    for (const msg of translated) {
      otherMessages.push(msg)
      originMap.push(i)
    }
  }

  return { messages: [...systemMessages, ...otherMessages], originMap }
}

// Reserved keywords that Copilot API rejects in prompts
// These appear in system prompts from Claude Code (e.g., "x-anthropic-billing-header: cc_version=...")
// See: https://github.com/ericc-ch/copilot-api/issues/174
const RESERVED_KEYWORDS = ["x-anthropic-billing-header", "x-anthropic-billing"]

/**
 * Filter out reserved keywords from system prompt text.
 * Copilot API rejects requests containing these keywords.
 * Removes the entire line containing the keyword to keep the prompt clean.
 */
function filterReservedKeywords(text: string): string {
  let filtered = text
  for (const keyword of RESERVED_KEYWORDS) {
    if (text.includes(keyword)) {
      consola.debug(`[Reserved Keyword] Removing line containing "${keyword}"`)
      // Remove the entire line containing the keyword
      filtered = filtered
        .split("\n")
        .filter((line) => !line.includes(keyword))
        .join("\n")
    }
  }
  return filtered
}

function handleSystemPrompt(system: string | Array<AnthropicTextBlock> | undefined): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [
      {
        role: "system",
        content: filterReservedKeywords(system),
      },
    ]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [
      {
        role: "system",
        content: filterReservedKeywords(systemText),
      },
    ]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock => block.type === "tool_result",
    )
    const otherBlocks = message.content.filter((block) => block.type !== "tool_result")

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

function handleAssistantMessage(message: AnthropicAssistantMessage, toolNameMapping: ToolNameMapping): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")

  const textBlocks = message.content.filter((block): block is AnthropicTextBlock => block.type === "text")

  // Strip thinking/redacted_thinking blocks — OpenAI models don't understand them,
  // and they're not meant to be sent as regular text content.
  // Previous Anthropic thinking content is internal to the model and should not leak.
  const allTextContent = textBlocks.map((b) => b.text).join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: getTruncatedToolName(toolUse.name, toolNameMapping),
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
  content: string | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
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
      .filter((block): block is AnthropicTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

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
      // thinking/redacted_thinking blocks are stripped (not relevant for OpenAI models)
      // No default
    }
  }
  return contentParts
}

// Truncate tool name to fit OpenAI's 64-character limit
// Uses consistent truncation with hash suffix to avoid collisions
function getTruncatedToolName(originalName: string, toolNameMapping: ToolNameMapping): string {
  // If already within limit, return as-is
  if (originalName.length <= OPENAI_TOOL_NAME_LIMIT) {
    return originalName
  }

  // Check if we've already truncated this name
  const existingTruncated = toolNameMapping.originalToTruncated.get(originalName)
  if (existingTruncated) {
    return existingTruncated
  }

  // Create a simple hash suffix from the original name
  // Use last 8 chars of a simple hash to ensure uniqueness
  let hash = 0
  for (let i = 0; i < originalName.length; i++) {
    const char = originalName.codePointAt(i) ?? 0
    hash = (hash << 5) - hash + char
    hash = Math.trunc(hash) // Convert to 32-bit integer
  }
  const hashSuffix = Math.abs(hash).toString(36).slice(0, 8)

  // Truncate: leave room for "_" + 8-char hash = 9 chars
  const truncatedName = originalName.slice(0, OPENAI_TOOL_NAME_LIMIT - 9) + "_" + hashSuffix

  // Store mapping in both directions
  toolNameMapping.truncatedToOriginal.set(truncatedName, originalName)
  toolNameMapping.originalToTruncated.set(originalName, truncatedName)

  consola.debug(`Truncated tool name: "${originalName}" -> "${truncatedName}"`)

  return truncatedName
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
  toolNameMapping: ToolNameMapping,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: getTruncatedToolName(tool.name, toolNameMapping),
      description: tool.description,
      parameters: tool.input_schema ?? {},
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
  toolNameMapping: ToolNameMapping,
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
          function: {
            name: getTruncatedToolName(anthropicToolChoice.name, toolNameMapping),
          },
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

/** Create empty response for edge case of no choices */
function createEmptyResponse(response: ChatCompletionResponse): AnthropicResponse {
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

/** Build usage object from response */
function buildUsageObject(response: ChatCompletionResponse) {
  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: (response.usage?.prompt_tokens ?? 0) - (cachedTokens ?? 0),
    output_tokens: response.usage?.completion_tokens ?? 0,
    ...(cachedTokens !== undefined && {
      cache_read_input_tokens: cachedTokens,
    }),
  }
}

export function translateToAnthropic(
  response: ChatCompletionResponse,
  toolNameMapping?: ToolNameMapping,
): AnthropicResponse {
  // Handle edge case of empty choices array
  if (response.choices.length === 0) {
    return createEmptyResponse(response)
  }

  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null = null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls, toolNameMapping)

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
    usage: buildUsageObject(response),
  }
}

function getAnthropicTextBlocks(messageContent: Message["content"]): Array<AnthropicTextBlock> {
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
  toolNameMapping?: ToolNameMapping,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    } catch (error) {
      consola.warn(`Failed to parse tool call arguments for ${toolCall.function.name}:`, error)
    }

    // Restore original tool name if it was truncated
    const originalName = toolNameMapping?.truncatedToOriginal.get(toolCall.function.name) ?? toolCall.function.name

    return {
      type: "tool_use",
      id: toolCall.id,
      name: originalName,
      input,
    }
  })
}
