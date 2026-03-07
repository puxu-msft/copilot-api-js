/**
 * Conversion utilities for Responses API data structures.
 *
 * Converts between OpenAI Responses API input/output formats and the
 * unified MessageContent format used for history storage and display.
 */

import type { MessageContent } from "~/lib/history"
import type { ResponsesInputItem, ResponsesOutputItem } from "~/types/api/openai-responses"

// ============================================================================
// Input conversion
// ============================================================================

/**
 * Convert Responses API input items to MessageContent format for history storage.
 * Maps Responses-specific item types to the unified MessageContent structure
 * that the history UI understands.
 */
export function responsesInputToMessages(input: string | Array<ResponsesInputItem>): Array<MessageContent> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }]
  }

  const messages: Array<MessageContent> = []
  for (const item of input) {
    switch (item.type) {
      case "message":
      case undefined: {
        // Regular message — convert content parts to Anthropic-style blocks
        const role = item.role ?? "user"
        let content: string | Array<unknown> | null

        if (typeof item.content === "string") {
          content = item.content
        } else if (Array.isArray(item.content)) {
          content = item.content.map((part) => {
            switch (part.type) {
              case "input_text": {
                return { type: "text", text: part.text }
              }
              case "output_text": {
                return { type: "text", text: part.text }
              }
              case "input_image": {
                return { type: "image", source: { type: "url", url: part.image_url } }
              }
              case "input_file": {
                return { type: "file", file_id: part.file_id, filename: part.filename }
              }
              default: {
                return part
              }
            }
          })
        } else {
          content = null
        }

        messages.push({ role, content })
        break
      }

      case "function_call": {
        // Function call from assistant — convert to OpenAI tool_calls format
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? item.id ?? "",
              type: "function",
              function: { name: item.name ?? "", arguments: item.arguments ?? "" },
            },
          ],
        })
        break
      }

      case "function_call_output": {
        // Function output — convert to OpenAI tool response format
        messages.push({
          role: "tool",
          content: item.output ?? "",
          tool_call_id: item.call_id ?? "",
        })
        break
      }

      case "item_reference": {
        // Item reference — store as informational marker
        messages.push({
          role: "system",
          content: `[item_reference: ${item.id ?? "unknown"}]`,
        })
        break
      }

      case "reasoning": {
        // Reasoning item — store as assistant marker for history display
        messages.push({
          role: "assistant",
          content: `[reasoning: ${item.id ?? "unknown"}]`,
        })
        break
      }

      default: {
        // Unknown/custom item types (e.g. compaction) — store as system marker
        if (item.type && item.id) {
          messages.push({
            role: "system",
            content: `[${item.type}: ${item.id}]`,
          })
        }
        break
      }
    }
  }

  return messages
}

// ============================================================================
// Output conversion
// ============================================================================

/**
 * Convert Responses API output items to a unified MessageContent for history storage.
 * Extracts text content and function calls from the output array.
 */
export function responsesOutputToContent(output: Array<ResponsesOutputItem>): MessageContent | null {
  const textParts: Array<string> = []
  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") textParts.push(part.text)
        if (part.type === "refusal") textParts.push(`[Refusal: ${part.refusal}]`)
      }
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
    if (item.type === "reasoning") {
      const summaryText = item.summary
        .map((s) => s.text)
        .filter(Boolean)
        .join("\n")
      if (summaryText) textParts.push(`[Reasoning: ${summaryText}]`)
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) return null

  return {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
}
