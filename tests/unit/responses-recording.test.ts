/**
 * Tests for buildResponsesResponseData — converts Responses API stream
 * accumulator into the unified ResponseData format for history recording.
 */

import { describe, expect, test } from "bun:test"

import { createResponsesStreamAccumulator } from "~/lib/openai/responses-stream-accumulator"
import { buildResponsesResponseData } from "~/lib/request/recording"

describe("buildResponsesResponseData", () => {
  test("builds response data with text content", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "gpt-4o"
    acc.inputTokens = 100
    acc.outputTokens = 50
    acc.status = "completed"
    acc.contentParts.push("Hello ", "world!")

    const result = buildResponsesResponseData(acc, "fallback-model")

    expect(result.success).toBe(true)
    expect(result.model).toBe("gpt-4o")
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 })
    expect(result.stop_reason).toBe("completed")
    expect(result.content).toEqual({
      role: "assistant",
      content: "Hello world!",
      tool_calls: undefined,
    })
  })

  test("uses fallback model when accumulator model is empty", () => {
    const acc = createResponsesStreamAccumulator()
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "fallback-model")
    expect(result.model).toBe("fallback-model")
  })

  test("builds response with tool calls from toolCalls array", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "gpt-4o"
    acc.toolCalls.push({
      id: "fc_1",
      callId: "call_abc",
      name: "get_weather",
      arguments: '{"city":"Tokyo"}',
    })

    const result = buildResponsesResponseData(acc, "fallback")

    expect(result.content).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
      ],
    })
  })

  test("prefers callId over id for tool call identifiers", () => {
    const acc = createResponsesStreamAccumulator()
    acc.toolCalls.push({
      id: "fc_internal",
      callId: "call_external",
      name: "search",
      arguments: "{}",
    })

    const result = buildResponsesResponseData(acc, "m")
    expect((result.content as any)?.tool_calls?.[0].id).toBe("call_external")
  })

  test("falls back to id when callId is empty", () => {
    const acc = createResponsesStreamAccumulator()
    acc.toolCalls.push({
      id: "fc_only",
      callId: "",
      name: "read",
      arguments: "{}",
    })

    const result = buildResponsesResponseData(acc, "m")
    expect((result.content as any)?.tool_calls?.[0].id).toBe("fc_only")
  })

  test("finalizes tool calls from toolCallMap", () => {
    const acc = createResponsesStreamAccumulator()
    // Simulate tool call accumulated via streaming (only in toolCallMap, not yet in toolCalls)
    acc.toolCallMap.set(0, {
      id: "fc_1",
      callId: "call_1",
      name: "calculator",
      argumentParts: ['{"expr":', '"2+2"}'],
    })

    const result = buildResponsesResponseData(acc, "model")

    expect((result.content as any)?.tool_calls).toHaveLength(1)
    expect((result.content as any)?.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "calculator", arguments: '{"expr":"2+2"}' },
    })
  })

  test("does not duplicate tool calls already in toolCalls array", () => {
    const acc = createResponsesStreamAccumulator()
    acc.toolCalls.push({
      id: "fc_1",
      callId: "call_1",
      name: "search",
      arguments: '{"q":"test"}',
    })
    // Same tool call also in toolCallMap
    acc.toolCallMap.set(0, {
      id: "fc_1",
      callId: "call_1",
      name: "search",
      argumentParts: ['{"q":"test"}'],
    })

    const result = buildResponsesResponseData(acc, "model")
    expect((result.content as any)?.tool_calls).toHaveLength(1)
  })

  test("combines text content with tool calls", () => {
    const acc = createResponsesStreamAccumulator()
    acc.contentParts.push("Let me search for that.")
    acc.toolCalls.push({
      id: "fc_1",
      callId: "call_1",
      name: "web_search",
      arguments: '{"query":"weather"}',
    })

    const result = buildResponsesResponseData(acc, "model")

    expect((result.content as any)?.content).toBe("Let me search for that.")
    expect((result.content as any)?.tool_calls).toHaveLength(1)
  })

  test("returns null content when no text and no tool calls", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "gpt-4o"
    acc.inputTokens = 10
    acc.outputTokens = 0

    const result = buildResponsesResponseData(acc, "fallback")

    expect(result.content).toBeNull()
  })

  test("stop_reason is undefined when status is empty", () => {
    const acc = createResponsesStreamAccumulator()
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "model")
    expect(result.stop_reason).toBeUndefined()
  })

  // ── Reasoning and cached token tests ──

  test("includes reasoning tokens in usage when present", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "gpt-4o"
    acc.inputTokens = 100
    acc.outputTokens = 50
    acc.reasoningTokens = 20
    acc.status = "completed"
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "fallback")

    expect(result.usage.output_tokens_details).toEqual({ reasoning_tokens: 20 })
  })

  test("includes cached input tokens in usage when present", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "gpt-4o"
    acc.inputTokens = 100
    acc.outputTokens = 50
    acc.cachedInputTokens = 30
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "fallback")

    expect(result.usage.cache_read_input_tokens).toBe(30)
  })

  test("omits reasoning tokens details when zero", () => {
    const acc = createResponsesStreamAccumulator()
    acc.inputTokens = 100
    acc.outputTokens = 50
    acc.reasoningTokens = 0
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "model")

    expect(result.usage.output_tokens_details).toBeUndefined()
  })

  test("omits cached input tokens when zero", () => {
    const acc = createResponsesStreamAccumulator()
    acc.inputTokens = 100
    acc.outputTokens = 50
    acc.cachedInputTokens = 0
    acc.contentParts.push("test")

    const result = buildResponsesResponseData(acc, "model")

    expect(result.usage.cache_read_input_tokens).toBeUndefined()
  })

  test("includes both reasoning and cached tokens when both present", () => {
    const acc = createResponsesStreamAccumulator()
    acc.model = "claude-opus-4.6"
    acc.inputTokens = 500
    acc.outputTokens = 200
    acc.reasoningTokens = 80
    acc.cachedInputTokens = 150
    acc.status = "completed"
    acc.contentParts.push("response text")

    const result = buildResponsesResponseData(acc, "fallback")

    expect(result.usage).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 80 },
      cache_read_input_tokens: 150,
    })
  })
})
