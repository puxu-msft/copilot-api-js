/**
 * Shared test factories for creating mock objects.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages"

import type { Model } from "~/lib/models/client"
import type { RequestContext } from "~/lib/context/request"
import type { ApiError, ApiErrorType } from "~/lib/error"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionChunk, ChatCompletionResponse } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"

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

/**
 * Create a minimal Anthropic Messages payload.
 */
export function mockAnthropicPayload(overrides?: Partial<MessagesPayload>): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  }
}

/**
 * Create an assistant message with one or more tool_use blocks.
 */
export function mockToolUseMessage(
  tools: Array<{ id: string; name: string; input: unknown }>,
): MessageParam {
  return {
    role: "assistant",
    content: tools.map((tool) => ({
      type: "tool_use" as const,
      id: tool.id,
      name: tool.name,
      input: tool.input,
    })),
  }
}

/**
 * Create a user message with tool_result blocks.
 */
export function mockToolResultMessage(
  results: Array<{ tool_use_id: string; content: string }>,
): MessageParam {
  return {
    role: "user",
    content: results.map((result) => ({
      type: "tool_result" as const,
      tool_use_id: result.tool_use_id,
      content: result.content,
    })),
  }
}

/**
 * Create an assistant message with a thinking block followed by text.
 */
export function mockThinkingMessage(thinking: string, text: string): MessageParam {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, signature: "mock-signature" },
      { type: "text", text },
    ],
  }
}

/**
 * Create a server-side tool use/result message pair.
 */
export function mockServerToolPair(
  toolName:
    | "web_search"
    | "tool_search_tool_regex"
    | "web_fetch"
    | "code_execution"
    | "bash_code_execution"
    | "text_editor_code_execution"
    | "tool_search_tool_bm25",
  input: Record<string, unknown>,
): { assistant: MessageParam; user: MessageParam } {
  const toolUseId = `srv_${toolName}`
  return {
    assistant: {
      role: "assistant",
      content: [
        {
          type: "server_tool_use" as const,
          id: toolUseId,
          name: toolName,
          input,
        },
      ],
    },
    user: {
      role: "user",
      content: [
        {
          type: "web_search_tool_result" as const,
          tool_use_id: toolUseId,
          content: [
            {
              type: "web_search_result",
              title: `Result for ${toolName}`,
              url: "https://example.com",
              encrypted_content: "mock-encrypted-content",
            },
          ],
        },
      ],
    },
  }
}

/**
 * Create a minimal Responses payload.
 */
export function mockResponsesPayload(overrides?: Partial<ResponsesPayload>): ResponsesPayload {
  return {
    model: "gpt-4o",
    input: "Hello",
    stream: false,
    ...overrides,
  }
}

/**
 * Create an HTTPError with optional response body.
 */
export function mockHTTPError(status: number, body?: string): HTTPError {
  return new HTTPError(`HTTP ${status}`, status, body ?? "")
}

/**
 * Create a classified API error object.
 */
export function mockApiError(type: ApiErrorType, overrides?: Partial<ApiError>): ApiError {
  return {
    type,
    status: overrides?.status ?? 400,
    message: overrides?.message ?? `Mock ${type} error`,
    raw: overrides?.raw ?? new Error(`Mock ${type} error`),
    retryAfter: overrides?.retryAfter,
    tokenLimit: overrides?.tokenLimit,
    tokenCurrent: overrides?.tokenCurrent,
    responseHeaders: overrides?.responseHeaders,
  }
}

/**
 * Create a real RequestContext instance for tests and seed its original request.
 */
export function mockRequestContext(overrides?: Partial<RequestContext>): RequestContext {
  const ctx = createRequestContext({
    endpoint: overrides?.endpoint ?? "openai-chat-completions",
    tuiLogId: overrides?.tuiLogId,
    onEvent: overrides?.transition ? () => {} : () => {},
  })

  ctx.setOriginalRequest({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    payload: { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] },
  })

  if (overrides?.queueWaitMs) {
    ctx.addQueueWaitMs(overrides.queueWaitMs)
  }

  return Object.assign(ctx, overrides)
}
