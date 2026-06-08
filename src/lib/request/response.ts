/**
 * Response utilities for request handlers.
 */

import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"

/** Type guard for non-streaming responses */
export function isNonStreaming(response: ChatCompletionResponse | AsyncIterable<unknown>): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}

/**
 * Parse a JSON string to object, returning the value as-is if already an object.
 *
 * If parsing fails (e.g. a streamed tool_use was aborted mid-JSON or upstream
 * emitted malformed JSON), returns a marker object `{ _parseError: true,
 * _rawInput: <original> }` so downstream consumers (history, replay, UI) can
 * still see the raw fragment instead of silently losing the data.
 */
export function safeParseJson(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return { _parseError: true, _rawInput: input }
  }
}

/** Prepend a marker string to the first text content block of an Anthropic-format response */
export function prependMarkerToResponse<T extends { content: Array<{ type: string; text?: string }> }>(response: T, marker: string): T {
  if (!marker) return response

  // Find first text block and prepend, or add new text block at start
  const content = [...response.content]
  const firstTextIndex = content.findIndex((block) => block.type === "text")

  if (firstTextIndex !== -1) {
    const textBlock = content[firstTextIndex]
    if (textBlock.type === "text") {
      content[firstTextIndex] = {
        ...textBlock,
        text: marker + (textBlock.text ?? ""),
      }
    }
  } else {
    // No text block found, add one at the beginning
    content.unshift({ type: "text", text: marker } as (typeof content)[number])
  }

  return { ...response, content }
}
