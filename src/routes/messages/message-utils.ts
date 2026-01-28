/**
 * Message utility functions for Anthropic message handling.
 * Handles message conversion and extraction.
 */

import type { MessageContent } from "~/lib/history"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/types/api/anthropic"

// Convert Anthropic messages to history MessageContent format
export function convertAnthropicMessages(
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
export function extractSystemPrompt(
  system: AnthropicMessagesPayload["system"],
): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n")
}

// Extract tool calls from response content (untyped version)
export function extractToolCallsFromContent(
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

// Extract tool calls from Anthropic content blocks (typed version)
export function extractToolCallsFromAnthropicContent(
  content: AnthropicResponse["content"],
): Array<{ id: string; name: string; input: string }> | undefined {
  const tools: Array<{ id: string; name: string; input: string }> = []
  for (const block of content) {
    if (block.type === "tool_use") {
      tools.push({
        id: block.id,
        name: block.name,
        input: JSON.stringify(block.input),
      })
    }
  }
  return tools.length > 0 ? tools : undefined
}

// Map OpenAI finish_reason to Anthropic stop_reason
export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}
