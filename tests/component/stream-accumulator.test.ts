/**
 * Component tests for Anthropic stream accumulator.
 *
 * Tests: createAnthropicStreamAccumulator, accumulateAnthropicStreamEvent,
 * convenience extractors, and content block ordering.
 */

import { describe, expect, test } from "bun:test"

import {
  createAnthropicStreamAccumulator,
  getRedactedThinkingCount,
  getTextContent,
  getThinkingContent,
  accumulateAnthropicStreamEvent,
} from "~/lib/anthropic/stream-accumulator"

// ─── Initialization ───

describe("createAnthropicStreamAccumulator", () => {
  test("initializes with empty/zero state", () => {
    const acc = createAnthropicStreamAccumulator()
    expect(acc.model).toBe("")
    expect(acc.content).toBe("")
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
    expect(acc.cacheReadTokens).toBe(0)
    expect(acc.cacheCreationTokens).toBe(0)
    expect(acc.stopReason).toBe("")
    expect(acc.contentBlocks).toEqual([])
    expect(acc.copilotAnnotations).toEqual([])
  })
})

// ─── Event processing ───

describe("accumulateAnthropicStreamEvent", () => {
  test("processes message_start: extracts model and usage", () => {
    const acc = createAnthropicStreamAccumulator()
    accumulateAnthropicStreamEvent(
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-4-20250514",
          usage: {
            input_tokens: 500,
            output_tokens: 0,
          },
        },
      } as any,
      acc,
    )

    expect(acc.model).toBe("claude-sonnet-4-20250514")
    expect(acc.inputTokens).toBe(500)
    expect(acc.outputTokens).toBe(0)
  })

  test("processes message_start with cache stats", () => {
    const acc = createAnthropicStreamAccumulator()
    accumulateAnthropicStreamEvent(
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
          },
        },
      } as any,
      acc,
    )

    expect(acc.cacheReadTokens).toBe(800)
    expect(acc.cacheCreationTokens).toBe(200)
  })

  test("processes content_block_start tool_use: creates tool call entry", () => {
    const acc = createAnthropicStreamAccumulator()
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tu_123",
          name: "search",
          input: {},
        },
      } as any,
      acc,
    )

    expect(acc.contentBlocks).toHaveLength(1)
    expect(acc.contentBlocks[0].type).toBe("tool_use")
    const block = acc.contentBlocks[0] as { type: "tool_use"; id: string; name: string }
    expect(block.id).toBe("tu_123")
    expect(block.name).toBe("search")
  })

  test("processes content_block_start server_tool_use", () => {
    const acc = createAnthropicStreamAccumulator()
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "stu_456",
          name: "tool_search_tool_regex",
        },
      } as any,
      acc,
    )

    expect(acc.contentBlocks).toHaveLength(1)
    expect(acc.contentBlocks[0].type).toBe("server_tool_use")
  })

  test("processes content_block_delta text_delta: accumulates content", () => {
    const acc = createAnthropicStreamAccumulator()

    // Start a text block first
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      } as any,
      acc,
    )

    const block = acc.contentBlocks[0] as { type: "text"; text: string }
    expect(block.text).toBe("Hello world!")
    // Also synced to acc.content
    expect(acc.content).toBe("Hello world!")
  })

  test("processes content_block_delta input_json_delta: accumulates tool input", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"test"}' },
      } as any,
      acc,
    )

    const block = acc.contentBlocks[0] as { type: "tool_use"; input: string }
    expect(block.input).toBe('{"query":"test"}')
  })

  test("processes content_block_delta thinking_delta: accumulates thinkingContent", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think " },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "about this..." },
      } as any,
      acc,
    )

    const block = acc.contentBlocks[0] as { type: "thinking"; thinking: string }
    expect(block.thinking).toBe("Let me think about this...")
  })

  test("processes content_block_stop: block data is preserved", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":"test"}' },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_stop",
        index: 0,
      } as any,
      acc,
    )

    expect(acc.contentBlocks).toHaveLength(1)
    const block = acc.contentBlocks[0] as { type: "tool_use"; input: string }
    expect(block.input).toBe('{"q":"test"}')
  })

  test("processes message_delta: sets stopReason and output usage", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 150 },
      } as any,
      acc,
    )

    expect(acc.stopReason).toBe("end_turn")
    expect(acc.outputTokens).toBe(150)
  })

  test("accumulates multiple tool calls", () => {
    const acc = createAnthropicStreamAccumulator()

    // First tool
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":"a"}' },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    // Second tool
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_2", name: "read", input: {} },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"f":"b"}' },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 1 } as any, acc)

    expect(acc.contentBlocks).toHaveLength(2)
    const toolCalls = acc.contentBlocks.filter((b) => b.type === "tool_use" || b.type === "server_tool_use")
    expect(toolCalls).toHaveLength(2)
    expect((toolCalls[0] as any).id).toBe("tu_1")
    expect((toolCalls[1] as any).id).toBe("tu_2")
  })

  test("ignores message_stop events gracefully", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.content = "preserved"

    accumulateAnthropicStreamEvent(
      {
        type: "message_stop",
      } as any,
      acc,
    )

    expect(acc.content).toBe("preserved")
  })

  test("ignores unknown event types gracefully", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.content = "preserved"

    accumulateAnthropicStreamEvent(
      {
        type: "ping",
      } as any,
      acc,
    )

    expect(acc.content).toBe("preserved")
  })

  test("collects copilot annotations from deltas", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      } as any,
      acc,
    )

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "code" },
        copilot_annotations: {
          ip_code_citations: [{ url: "https://github.com/repo", license: "MIT" }],
        },
      } as any,
      acc,
    )

    expect(acc.copilotAnnotations).toHaveLength(1)
    expect(acc.copilotAnnotations[0].ip_code_citations![0].url).toBe("https://github.com/repo")
  })
})

// ─── Content block ordering ───

describe("content block ordering", () => {
  test("preserves stream order: thinking → text → tool_use", () => {
    const acc = createAnthropicStreamAccumulator()

    // thinking block
    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning..." } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    // text block
    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 1 } as any, acc)

    // tool_use block
    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 2 } as any, acc)

    expect(acc.contentBlocks).toHaveLength(3)
    expect(acc.contentBlocks[0].type).toBe("thinking")
    expect(acc.contentBlocks[1].type).toBe("text")
    expect(acc.contentBlocks[2].type).toBe("tool_use")
  })

  test("preserves interleaved text and thinking blocks", () => {
    const acc = createAnthropicStreamAccumulator()

    // text → thinking → text
    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part 1" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Hmm..." } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 1 } as any, acc)

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Part 2" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 2 } as any, acc)

    expect(acc.contentBlocks).toHaveLength(3)
    expect(acc.contentBlocks[0].type).toBe("text")
    expect(acc.contentBlocks[1].type).toBe("thinking")
    expect(acc.contentBlocks[2].type).toBe("text")

    // acc.content should have both text blocks
    expect(acc.content).toBe("Part 1Part 2")
    expect(getTextContent(acc)).toBe("Part 1Part 2")
  })
})

// ─── New content block types ───

describe("web_search_tool_result blocks", () => {
  test("accumulates web_search_tool_result at block_start", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "stu_ws_1",
          content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
        },
      } as any,
      acc,
    )

    expect(acc.contentBlocks).toHaveLength(1)
    expect(acc.contentBlocks[0].type).toBe("web_search_tool_result")
    const block = acc.contentBlocks[0] as { type: "web_search_tool_result"; tool_use_id: string; content: unknown }
    expect(block.tool_use_id).toBe("stu_ws_1")
    expect(block.content).toEqual([{ type: "web_search_result", url: "https://example.com", title: "Example" }])
  })
})

describe("redacted_thinking blocks", () => {
  test("preserves redacted_thinking data field", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "base64encodeddata==" },
      } as any,
      acc,
    )

    expect(acc.contentBlocks).toHaveLength(1)
    expect(acc.contentBlocks[0].type).toBe("redacted_thinking")
    const block = acc.contentBlocks[0] as { type: "redacted_thinking"; data: string }
    expect(block.data).toBe("base64encodeddata==")
  })

  test("getRedactedThinkingCount returns correct count", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "a" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "b" } } as any,
      acc,
    )

    expect(getRedactedThinkingCount(acc)).toBe(2)
  })
})

describe("signature_delta", () => {
  test("accumulates signature_delta into thinking block", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking..." } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123abc" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    const block = acc.contentBlocks[0] as { type: "thinking"; thinking: string; signature?: string }
    expect(block.thinking).toBe("Thinking...")
    expect(block.signature).toBe("sig123abc")
  })
})

// ─── Convenience extractors ───

describe("convenience extractors", () => {
  test("getTextContent returns concatenated text from all text blocks", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world!" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 1 } as any, acc)

    expect(getTextContent(acc)).toBe("Hello world!")
    // acc.content stays in sync
    expect(acc.content).toBe(getTextContent(acc))
  })

  test("getThinkingContent returns concatenated thinking from all thinking blocks", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1. " } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 0 } as any, acc)

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Step 2." } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent({ type: "content_block_stop", index: 1 } as any, acc)

    expect(getThinkingContent(acc)).toBe("Step 1. Step 2.")
  })
})

// ─── Incomplete stream handling ───

describe("incomplete stream", () => {
  test("preserves partial tool input when stream is interrupted", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } } as any,
      acc,
    )

    // Stream interrupted - no content_block_stop
    // Block data is preserved (partial input)
    const block = acc.contentBlocks[0] as { type: "tool_use"; input: string }
    expect(block.input).toBe('{"q":')
  })

  test("preserves partial text content when stream is interrupted", () => {
    const acc = createAnthropicStreamAccumulator()

    accumulateAnthropicStreamEvent(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as any,
      acc,
    )
    accumulateAnthropicStreamEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial..." } } as any,
      acc,
    )

    // Stream interrupted - no content_block_stop
    const block = acc.contentBlocks[0] as { type: "text"; text: string }
    expect(block.text).toBe("partial...")
    expect(acc.content).toBe("partial...")
  })
})
