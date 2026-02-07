/**
 * Unit tests for Anthropic message utility functions.
 *
 * Tests: mapOpenAIStopReasonToAnthropic, convertAnthropicMessages,
 *        extractSystemPrompt, extractToolCallsFromContent,
 *        extractToolCallsFromAnthropicContent
 */

import { describe, expect, test } from "bun:test"

import {
  convertAnthropicMessages,
  extractSystemPrompt,
  extractToolCallsFromAnthropicContent,
  extractToolCallsFromContent,
  mapOpenAIStopReasonToAnthropic,
} from "~/lib/anthropic/message-utils"

// ─── mapOpenAIStopReasonToAnthropic ───

describe("mapOpenAIStopReasonToAnthropic", () => {
  test("maps 'stop' to 'end_turn'", () => {
    expect(mapOpenAIStopReasonToAnthropic("stop")).toBe("end_turn")
  })

  test("maps 'length' to 'max_tokens'", () => {
    expect(mapOpenAIStopReasonToAnthropic("length")).toBe("max_tokens")
  })

  test("maps 'tool_calls' to 'tool_use'", () => {
    expect(mapOpenAIStopReasonToAnthropic("tool_calls")).toBe("tool_use")
  })

  test("maps 'content_filter' to 'end_turn'", () => {
    expect(mapOpenAIStopReasonToAnthropic("content_filter")).toBe("end_turn")
  })

  test("maps null to null", () => {
    expect(mapOpenAIStopReasonToAnthropic(null)).toBeNull()
  })
})

// ─── convertAnthropicMessages ───

describe("convertAnthropicMessages", () => {
  test("converts user text message with string content", () => {
    const messages = [{ role: "user" as const, content: "Hello" }]
    const result = convertAnthropicMessages(messages)
    expect(result).toEqual([{ role: "user", content: "Hello" }])
  })

  test("converts user message with text content block", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello world" }],
      },
    ]
    const result = convertAnthropicMessages(messages)
    expect(result[0].role).toBe("user")
    expect(result[0].content).toEqual([{ type: "text", text: "Hello world" }])
  })

  test("converts assistant message with tool_use", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "tu_123", name: "search", input: { query: "test" } }],
      },
    ]
    const result = convertAnthropicMessages(messages)
    expect(result[0].content).toEqual([{ type: "tool_use", id: "tu_123", name: "search", input: { query: "test" } }])
  })

  test("converts user message with tool_result", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "tu_123", content: "result text" }],
      },
    ]
    const result = convertAnthropicMessages(messages)
    expect(result[0].content).toEqual([{ type: "tool_result", tool_use_id: "tu_123", content: "result text" }])
  })

  test("converts tool_result with array content", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "tu_123",
            content: [
              { type: "text" as const, text: "line 1" },
              { type: "text" as const, text: "line 2" },
            ],
          },
        ],
      },
    ]
    const result = convertAnthropicMessages(messages)
    expect((result[0].content as Array<any>)[0].content).toBe("line 1\nline 2")
  })

  test("handles empty messages array", () => {
    expect(convertAnthropicMessages([])).toEqual([])
  })

  test("handles thinking blocks", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "thinking" as const, thinking: "Let me think..." }],
      },
    ]
    const result = convertAnthropicMessages(messages)
    expect((result[0].content as Array<any>)[0]).toEqual({
      type: "thinking",
      thinking: "Let me think...",
    })
  })
})

// ─── extractSystemPrompt ───

describe("extractSystemPrompt", () => {
  test("returns undefined for undefined input", () => {
    expect(extractSystemPrompt(undefined)).toBeUndefined()
  })

  test("returns string as-is", () => {
    expect(extractSystemPrompt("You are a helpful assistant")).toBe("You are a helpful assistant")
  })

  test("joins array of TextBlock texts with newline", () => {
    const system = [
      { type: "text" as const, text: "First instruction" },
      { type: "text" as const, text: "Second instruction" },
    ]
    expect(extractSystemPrompt(system)).toBe("First instruction\nSecond instruction")
  })
})

// ─── extractToolCallsFromContent ───

describe("extractToolCallsFromContent", () => {
  test("extracts tool_use blocks", () => {
    const content = [
      { type: "text", text: "some text" },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } },
      { type: "tool_use", id: "tu_2", name: "read", input: { file: "a.ts" } },
    ]
    const result = extractToolCallsFromContent(content)
    expect(result).toHaveLength(2)
    expect(result![0]).toEqual({ id: "tu_1", name: "search", input: { q: "test" } })
    expect(result![1]).toEqual({ id: "tu_2", name: "read", input: { file: "a.ts" } })
  })

  test("returns undefined for content with no tool_use", () => {
    const content = [{ type: "text", text: "hello" }]
    expect(extractToolCallsFromContent(content)).toBeUndefined()
  })

  test("returns undefined for empty content array", () => {
    expect(extractToolCallsFromContent([])).toBeUndefined()
  })
})

// ─── extractToolCallsFromAnthropicContent ───

describe("extractToolCallsFromAnthropicContent", () => {
  test("extracts tool_use blocks from typed content", () => {
    const content = [
      { type: "text" as const, text: "some text" },
      { type: "tool_use" as const, id: "tu_1", name: "search", input: { q: "test" } },
    ]
    const result = extractToolCallsFromAnthropicContent(content)
    expect(result).toHaveLength(1)
    expect(result![0].id).toBe("tu_1")
  })

  test("returns undefined when no tool calls", () => {
    const content = [{ type: "text" as const, text: "hello" }]
    expect(extractToolCallsFromAnthropicContent(content)).toBeUndefined()
  })
})
