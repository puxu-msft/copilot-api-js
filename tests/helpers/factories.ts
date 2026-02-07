/**
 * Shared test factories for creating mock objects.
 */

import type { Model } from "~/services/copilot/get-models"
import type { ChatCompletionChunk, ChatCompletionResponse } from "~/types/api/openai"

/**
 * Create a mock Model with sensible defaults.
 */
export function mockModel(id: string, overrides?: Partial<Model>): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "1.0",
    vendor: "openai",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: "gpt-4",
      type: "chat",
      limits: {
        max_context_window_tokens: 128000,
        max_output_tokens: 4096,
        max_prompt_tokens: 100000,
      },
    },
    ...overrides,
  }
}

/**
 * Create a mock ChatCompletionResponse.
 */
export function mkResponse(overrides?: Partial<ChatCompletionResponse>): ChatCompletionResponse {
  return {
    id: "chatcmpl-test-123",
    object: "chat.completion",
    created: Date.now(),
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    ...overrides,
  }
}

/**
 * Create a mock ChatCompletionChunk.
 */
export function mkChunk(overrides?: Partial<ChatCompletionChunk>): ChatCompletionChunk {
  return {
    id: "chatcmpl-test-chunk-123",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: { content: "Hello" },
        finish_reason: null,
        logprobs: null,
      },
    ],
    ...overrides,
  }
}

/**
 * Create a minimal OpenAI chat completions payload.
 */
export function mockOpenAIPayload(overrides?: Record<string, unknown>) {
  return {
    model: "gpt-4o",
    messages: [{ role: "user" as const, content: "Hello" }],
    stream: false,
    ...overrides,
  }
}
