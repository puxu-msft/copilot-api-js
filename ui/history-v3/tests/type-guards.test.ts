/**
 * Tests for type guard functions and normalizeToContentBlocks.
 *
 * Covers: isTextBlock, isThinkingBlock, isRedactedThinkingBlock,
 *         isToolUseBlock, isToolResultBlock, isImageBlock,
 *         hasOpenAIToolCalls, isOpenAIToolResponse,
 *         normalizeToContentBlocks
 */

import { describe, expect, test } from "bun:test"

import type { ContentBlock, MessageContent } from "../src/types"
import {
  isTextBlock,
  isThinkingBlock,
  isRedactedThinkingBlock,
  isToolUseBlock,
  isToolResultBlock,
  isImageBlock,
  hasOpenAIToolCalls,
  isOpenAIToolResponse,
  normalizeToContentBlocks,
} from "../src/utils/typeGuards"

// ─── Block type guards ───

describe("isTextBlock", () => {
  test("returns true for text blocks", () => {
    expect(isTextBlock({ type: "text", text: "hello" } as ContentBlock)).toBe(true)
  })

  test("returns false for non-text blocks", () => {
    expect(isTextBlock({ type: "tool_use" } as ContentBlock)).toBe(false)
    expect(isTextBlock({ type: "thinking" } as ContentBlock)).toBe(false)
  })
})

describe("isThinkingBlock", () => {
  test("returns true for thinking blocks", () => {
    expect(isThinkingBlock({ type: "thinking", thinking: "..." } as ContentBlock)).toBe(true)
  })

  test("returns false for non-thinking blocks", () => {
    expect(isThinkingBlock({ type: "text" } as ContentBlock)).toBe(false)
    expect(isThinkingBlock({ type: "redacted_thinking" } as ContentBlock)).toBe(false)
  })
})

describe("isRedactedThinkingBlock", () => {
  test("returns true for redacted_thinking blocks", () => {
    expect(isRedactedThinkingBlock({ type: "redacted_thinking" } as ContentBlock)).toBe(true)
  })

  test("returns false for thinking blocks", () => {
    expect(isRedactedThinkingBlock({ type: "thinking" } as ContentBlock)).toBe(false)
  })
})

describe("isToolUseBlock", () => {
  test("returns true for tool_use blocks", () => {
    expect(isToolUseBlock({ type: "tool_use", id: "1", name: "Read", input: {} } as ContentBlock)).toBe(true)
  })

  test("returns false for tool_result blocks", () => {
    expect(isToolUseBlock({ type: "tool_result" } as ContentBlock)).toBe(false)
  })
})

describe("isToolResultBlock", () => {
  test("returns true for tool_result blocks", () => {
    expect(isToolResultBlock({ type: "tool_result", tool_use_id: "1", content: "" } as ContentBlock)).toBe(true)
  })

  test("returns false for tool_use blocks", () => {
    expect(isToolResultBlock({ type: "tool_use" } as ContentBlock)).toBe(false)
  })
})

describe("isImageBlock", () => {
  test("returns true for image blocks", () => {
    expect(isImageBlock({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } } as ContentBlock)).toBe(true)
  })

  test("returns false for text blocks", () => {
    expect(isImageBlock({ type: "text" } as ContentBlock)).toBe(false)
  })
})

// ─── OpenAI format helpers ───

describe("hasOpenAIToolCalls", () => {
  test("returns true when tool_calls array is non-empty", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }],
    } as unknown as MessageContent
    expect(hasOpenAIToolCalls(msg)).toBe(true)
  })

  test("returns false when tool_calls is empty", () => {
    const msg = { role: "assistant", content: "hi", tool_calls: [] } as unknown as MessageContent
    expect(hasOpenAIToolCalls(msg)).toBe(false)
  })

  test("returns false when tool_calls is undefined", () => {
    const msg = { role: "assistant", content: "hi" } as MessageContent
    expect(hasOpenAIToolCalls(msg)).toBe(false)
  })
})

describe("isOpenAIToolResponse", () => {
  test("returns true for tool role with tool_call_id", () => {
    const msg = { role: "tool", content: "42", tool_call_id: "call_1" } as unknown as MessageContent
    expect(isOpenAIToolResponse(msg)).toBe(true)
  })

  test("returns false for user role", () => {
    const msg = { role: "user", content: "hello" } as MessageContent
    expect(isOpenAIToolResponse(msg)).toBe(false)
  })

  test("returns false for tool role without tool_call_id", () => {
    const msg = { role: "tool", content: "42" } as unknown as MessageContent
    expect(isOpenAIToolResponse(msg)).toBe(false)
  })
})

// ─── normalizeToContentBlocks ───

describe("normalizeToContentBlocks", () => {
  test("returns Anthropic content blocks as-is", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "1", name: "Read", input: {} },
    ] as ContentBlock[]
    const msg = { role: "assistant", content: blocks } as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toEqual(blocks)
  })

  test("converts OpenAI string content to text block", () => {
    const msg = { role: "user", content: "hello" } as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("text")
    expect((result[0] as any).text).toBe("hello")
  })

  test("skips empty string content", () => {
    const msg = { role: "assistant", content: "" } as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(0)
  })

  test("converts OpenAI tool_calls to tool_use blocks", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"cats"}' } },
        { id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"foo.ts"}' } },
      ],
    } as unknown as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe("tool_use")
    expect((result[0] as any).name).toBe("search")
    expect((result[0] as any).input).toEqual({ q: "cats" })
    expect(result[1].type).toBe("tool_use")
    expect((result[1] as any).name).toBe("read")
    expect((result[1] as any).input).toEqual({ path: "foo.ts" })
  })

  test("combines text content and tool_calls", () => {
    const msg = {
      role: "assistant",
      content: "Let me search",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
      ],
    } as unknown as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe("text")
    expect(result[1].type).toBe("tool_use")
  })

  test("converts OpenAI tool response to tool_result block", () => {
    const msg = {
      role: "tool",
      content: "result data",
      tool_call_id: "call_1",
    } as unknown as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("tool_result")
    expect((result[0] as any).tool_use_id).toBe("call_1")
    expect((result[0] as any).content).toBe("result data")
  })

  test("handles tool_calls with invalid JSON arguments", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "broken", arguments: "not json" } },
      ],
    } as unknown as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect(result).toHaveLength(1)
    expect((result[0] as any).input).toEqual({ _raw: "not json" })
  })

  test("converts non-string tool response content to JSON string", () => {
    const msg = {
      role: "tool",
      content: { key: "value" },
      tool_call_id: "call_1",
    } as unknown as MessageContent
    const result = normalizeToContentBlocks(msg)
    expect((result[0] as any).content).toBe('{"key":"value"}')
  })
})
