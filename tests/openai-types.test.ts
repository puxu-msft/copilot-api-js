import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatCompletionUsage,
  JsonSchemaResponseFormat,
  Tool,
} from "~/types/api/openai"

describe("OpenAI Type Definitions", () => {
  describe("ChatCompletionsPayload new fields", () => {
    test("should accept stream_options", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        stream: true,
        stream_options: { include_usage: true },
      }
      expect(payload.stream_options?.include_usage).toBe(true)
    })

    test("should accept parallel_tool_calls", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        parallel_tool_calls: false,
      }
      expect(payload.parallel_tool_calls).toBe(false)
    })

    test("should accept service_tier", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        service_tier: "auto",
      }
      expect(payload.service_tier).toBe("auto")
    })

    test("should accept top_logprobs", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        logprobs: true,
        top_logprobs: 5,
      }
      expect(payload.top_logprobs).toBe(5)
    })

    test("should accept developer role messages", () => {
      const payload: ChatCompletionsPayload = {
        messages: [
          { role: "developer", content: "You are helpful" },
          { role: "user", content: "hello" },
        ],
        model: "gpt-4o",
      }
      expect(payload.messages[0].role).toBe("developer")
    })
  })

  describe("ResponseFormat variants", () => {
    test("should accept json_schema response_format", () => {
      const format: JsonSchemaResponseFormat = {
        type: "json_schema",
        json_schema: {
          name: "my_schema",
          schema: { type: "object", properties: { name: { type: "string" } } },
          strict: true,
        },
      }
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        response_format: format,
      }
      expect((payload.response_format as JsonSchemaResponseFormat).type).toBe("json_schema")
      expect((payload.response_format as JsonSchemaResponseFormat).json_schema.strict).toBe(true)
    })

    test("should accept json_object response_format", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        response_format: { type: "json_object" },
      }
      expect(payload.response_format?.type).toBe("json_object")
    })

    test("should accept text response_format", () => {
      const payload: ChatCompletionsPayload = {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4o",
        response_format: { type: "text" },
      }
      expect(payload.response_format?.type).toBe("text")
    })
  })

  describe("Tool strict parameter", () => {
    test("should accept strict: true on tool function", () => {
      const tool: Tool = {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      }
      expect(tool.function.strict).toBe(true)
    })

    test("should work without strict (backward compatible)", () => {
      const tool: Tool = {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object" },
        },
      }
      expect(tool.function.strict).toBeUndefined()
    })
  })

  describe("ChatCompletionUsage with token details", () => {
    test("should include prompt_tokens_details.cached_tokens", () => {
      const usage: ChatCompletionUsage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      }
      expect(usage.prompt_tokens_details?.cached_tokens).toBe(80)
    })

    test("should include completion_tokens_details", () => {
      const usage: ChatCompletionUsage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: {
          accepted_prediction_tokens: 30,
          rejected_prediction_tokens: 5,
        },
      }
      expect(usage.completion_tokens_details?.accepted_prediction_tokens).toBe(30)
      expect(usage.completion_tokens_details?.rejected_prediction_tokens).toBe(5)
    })

    test("should work without optional details (backward compatible)", () => {
      const usage: ChatCompletionUsage = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }
      expect(usage.prompt_tokens_details).toBeUndefined()
      expect(usage.completion_tokens_details).toBeUndefined()
    })
  })

  describe("Response types with service_tier", () => {
    test("ChatCompletionResponse should include service_tier", () => {
      const response: ChatCompletionResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        service_tier: "default",
      }
      expect(response.service_tier).toBe("default")
    })

    test("ChatCompletionChunk should include service_tier", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        created: 1234567890,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
        service_tier: "auto",
      }
      expect(chunk.service_tier).toBe("auto")
    })
  })
})
