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
 * emitted malformed JSON), returns the raw string UNCHANGED. The upstream leg
 * (`outboundResponse`) must faithfully reflect what upstream sent — upstream
 * streams tool_use input as a JSON string, so an un-parseable fragment is kept
 * as that exact string, never wrapped in a proxy-fabricated marker object. No
 * data is lost, and downstream consumers (history, replay, UI) detect a
 * string-typed tool_use input and render the raw fragment directly.
 */
export function safeParseJson(input: string | Record<string, unknown>): Record<string, unknown> | string {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return input
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
