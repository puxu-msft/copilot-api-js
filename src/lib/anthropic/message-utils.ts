/**
 * Message utility functions for Anthropic message handling.
 * Handles message conversion and extraction.
 */

import type { MessageContent } from "~/lib/history"
import type { AnthropicMessagesPayload, AnthropicResponse } from "~/types/api/anthropic"

import { isServerToolResultBlock } from "~/types/api/anthropic"

// Convert Anthropic messages to history MessageContent format
export function convertAnthropicMessages(messages: AnthropicMessagesPayload["messages"]): Array<MessageContent> {
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
          input: block.input,
        }
      }
      if (block.type === "tool_result") {
        let resultContent: string
        if (typeof block.content === "string") {
          resultContent = block.content
        } else if (Array.isArray(block.content)) {
          resultContent = block.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
        } else {
          resultContent = ""
        }
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: resultContent,
        }
      }
      if (block.type === "server_tool_use") {
        return {
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        }
      }
      if (block.type === "thinking") {
        return {
          type: "thinking",
          thinking: (block as { thinking?: string }).thinking ?? "",
        }
      }
      if (block.type === "redacted_thinking") {
        return { type: "redacted_thinking" }
      }
      if (block.type === "web_search_tool_result") {
        return {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
        }
      }
      // Handle generic server tool results (e.g., tool_search_tool_result)
      if (isServerToolResultBlock(block)) {
        return {
          type: block.type,
          tool_use_id: block.tool_use_id,
        }
      }
      return { type: block.type }
    })

    return { role: msg.role, content }
  })
}

// Extract system prompt from Anthropic format
export function extractSystemPrompt(system: AnthropicMessagesPayload["system"]): string | undefined {
  if (!system) return undefined
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n")
}

// Extract tool calls from response content (untyped version)
export function extractToolCallsFromContent(
  content: Array<unknown>,
): Array<{ id: string; name: string; input: string | Record<string, unknown> }> | undefined {
  const tools: Array<{ id: string; name: string; input: string | Record<string, unknown> }> = []
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
        input: block.input as string | Record<string, unknown>,
      })
    }
  }
  return tools.length > 0 ? tools : undefined
}

// Extract tool calls from Anthropic content blocks (typed version)
export function extractToolCallsFromAnthropicContent(
  content: AnthropicResponse["content"],
): Array<{ id: string; name: string; input: string | Record<string, unknown> }> | undefined {
  const tools: Array<{ id: string; name: string; input: string | Record<string, unknown> }> = []
  for (const block of content) {
    if (block.type === "tool_use") {
      tools.push({
        id: block.id,
        name: block.name,
        input: block.input as string | Record<string, unknown>,
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
