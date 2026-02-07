/**
 * Response utilities for request handlers.
 */

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

/** Type guard for non-streaming responses */
export function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<unknown>,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}

/** Parse a JSON string to object, returning the value as-is if already an object */
export function safeParseJson(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return {}
  }
}
