import { describe, expect, test } from "bun:test"

import type { AnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import type { OpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"

import { buildAnthropicResponseData, buildOpenAIResponseData } from "~/lib/request/recording"

// ============================================================================
// Helpers
// ============================================================================

function makeAnthropicAcc(overrides: Partial<AnthropicStreamAccumulator> = {}): AnthropicStreamAccumulator {
  return {
    model: "claude-sonnet-4",
    inputTokens: 100,
    outputTokens: 50,
    content: "Hello",
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "end_turn",
    contentBlocks: [],
    copilotAnnotations: [],
    ...overrides,
  }
}

function makeOpenAIAcc(overrides: Partial<OpenAIStreamAccumulator> = {}): OpenAIStreamAccumulator {
  return {
    model: "gpt-4o",
    inputTokens: 80,
    outputTokens: 30,
    content: "Hi there",
    finishReason: "stop",
    cachedTokens: 0,
    toolCalls: [],
    toolCallMap: new Map(),
    ...overrides,
  }
}

// ============================================================================
// buildAnthropicResponseData
// ============================================================================

describe("buildAnthropicResponseData", () => {
  test("builds basic response with text content", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [{ type: "text", text: "Hello world" }],
    })

    const result = buildAnthropicResponseData(acc, "fallback-model")

    expect(result.success).toBe(true)
    expect(result.model).toBe("claude-sonnet-4")
    expect(result.stop_reason).toBe("end_turn")
    expect(result.usage.input_tokens).toBe(100)
    expect(result.usage.output_tokens).toBe(50)
    expect(result.content).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    })
  })

  test("uses fallback model when accumulator model is empty", () => {
    const acc = makeAnthropicAcc({ model: "" })
    const result = buildAnthropicResponseData(acc, "fallback-model")
    expect(result.model).toBe("fallback-model")
  })

  test("includes cache tokens when present", () => {
    const acc = makeAnthropicAcc({
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    })
    const result = buildAnthropicResponseData(acc, "fallback")
    expect(result.usage.cache_read_input_tokens).toBe(30)
    expect(result.usage.cache_creation_input_tokens).toBe(10)
  })

  test("omits cache tokens when zero", () => {
    const acc = makeAnthropicAcc()
    const result = buildAnthropicResponseData(acc, "fallback")
    expect(result.usage.cache_read_input_tokens).toBeUndefined()
    expect(result.usage.cache_creation_input_tokens).toBeUndefined()
  })

  test("maps tool_use content blocks", () => {
    const acc = makeAnthropicAcc({
      stopReason: "tool_use",
      contentBlocks: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: '{"location":"Tokyo"}',
        },
      ],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    expect(result.stop_reason).toBe("tool_use")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content).toHaveLength(2)
    expect(content.content[0]).toEqual({ type: "text", text: "Let me check." })
    expect(content.content[1]).toEqual({
      type: "tool_use",
      id: "toolu_123",
      name: "get_weather",
      input: { location: "Tokyo" },
    })
  })

  test("maps thinking content blocks", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Answer" },
      ],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." })
  })

  test("maps redacted_thinking content blocks", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [
        { type: "redacted_thinking", data: "" },
        { type: "text", text: "Answer" },
      ],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content[0]).toEqual({ type: "redacted_thinking" })
  })

  test("returns null content when no content blocks", () => {
    const acc = makeAnthropicAcc({ contentBlocks: [] })
    const result = buildAnthropicResponseData(acc, "fallback")
    expect(result.content).toBeNull()
  })

  test("passes through generic blocks", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [{ type: "custom_type", _generic: true, data: "value" } as any],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content[0]).toEqual({ type: "custom_type", data: "value" })
  })

  test("maps server_tool_use blocks", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [
        {
          type: "server_tool_use",
          id: "srvtoolu_123",
          name: "web_search",
          input: '{"query":"test"}',
        },
      ],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content[0]).toEqual({
      type: "server_tool_use",
      id: "srvtoolu_123",
      name: "web_search",
      input: { query: "test" },
    })
  })

  test("maps web_search_tool_result blocks", () => {
    const acc = makeAnthropicAcc({
      contentBlocks: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_123",
          content: [{ type: "web_search_result", url: "https://example.com", title: "Test" }],
        },
      ],
    })

    const result = buildAnthropicResponseData(acc, "fallback")
    const content = result.content as { role: string; content: Array<unknown> }
    expect(content.content[0]).toHaveProperty("type", "web_search_tool_result")
    expect(content.content[0]).toHaveProperty("tool_use_id", "srvtoolu_123")
  })
})

// ============================================================================
// buildOpenAIResponseData
// ============================================================================

describe("buildOpenAIResponseData", () => {
  test("builds basic response with text content", () => {
    const acc = makeOpenAIAcc()
    const result = buildOpenAIResponseData(acc, "fallback")

    expect(result.success).toBe(true)
    expect(result.model).toBe("gpt-4o")
    expect(result.stop_reason).toBe("stop")
    expect(result.usage.input_tokens).toBe(80)
    expect(result.usage.output_tokens).toBe(30)
    expect(result.content).toEqual({
      role: "assistant",
      content: "Hi there",
      tool_calls: undefined,
    })
  })

  test("uses fallback model when accumulator model is empty", () => {
    const acc = makeOpenAIAcc({ model: "" })
    const result = buildOpenAIResponseData(acc, "fallback-model")
    expect(result.model).toBe("fallback-model")
  })

  test("includes cached tokens when present", () => {
    const acc = makeOpenAIAcc({ cachedTokens: 25 })
    const result = buildOpenAIResponseData(acc, "fallback")
    expect(result.usage.cache_read_input_tokens).toBe(25)
  })

  test("omits cached tokens when zero", () => {
    const acc = makeOpenAIAcc({ cachedTokens: 0 })
    const result = buildOpenAIResponseData(acc, "fallback")
    expect(result.usage.cache_read_input_tokens).toBeUndefined()
  })

  test("builds tool calls from toolCalls array", () => {
    const acc = makeOpenAIAcc({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Tokyo"}' }],
    })

    const result = buildOpenAIResponseData(acc, "fallback")
    expect(result.stop_reason).toBe("tool_calls")
    const content = result.content as { role: string; tool_calls: Array<unknown> }
    expect(content.tool_calls).toHaveLength(1)
    expect(content.tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
    })
  })

  test("finalizes tool calls from toolCallMap", () => {
    const acc = makeOpenAIAcc()
    acc.toolCallMap.set(0, {
      id: "call_1",
      name: "search",
      argumentParts: ['{"q":', '"test"}'],
    })

    const result = buildOpenAIResponseData(acc, "fallback")
    const content = result.content as { role: string; tool_calls: Array<unknown> }
    expect(content.tool_calls).toHaveLength(1)
    expect(content.tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"test"}' },
    })
  })

  test("handles multiple tool calls from map", () => {
    const acc = makeOpenAIAcc()
    acc.toolCallMap.set(0, { id: "call_1", name: "a", argumentParts: ["{}"] })
    acc.toolCallMap.set(1, { id: "call_2", name: "b", argumentParts: ["{}"] })

    const result = buildOpenAIResponseData(acc, "fallback")
    const content = result.content as { role: string; tool_calls: Array<unknown> }
    expect(content.tool_calls).toHaveLength(2)
  })
})
