/**
 * Component tests for Anthropic stream accumulator.
 *
 * Tests: createAnthropicStreamAccumulator, processAnthropicEvent
 */

import { describe, expect, test } from "bun:test"

import { createAnthropicStreamAccumulator, processAnthropicEvent } from "~/lib/anthropic/stream-accumulator"

// ─── Initialization ───

describe("createAnthropicStreamAccumulator", () => {
  test("initializes with empty/zero state", () => {
    const acc = createAnthropicStreamAccumulator()
    expect(acc.model).toBe("")
    expect(acc.content).toBe("")
    expect(acc.thinkingContent).toBe("")
    expect(acc.inputTokens).toBe(0)
    expect(acc.outputTokens).toBe(0)
    expect(acc.cacheReadTokens).toBe(0)
    expect(acc.cacheCreationTokens).toBe(0)
    expect(acc.stopReason).toBe("")
    expect(acc.toolCalls).toEqual([])
    expect(acc.currentToolCall).toBeNull()
    expect(acc.currentBlockType).toBeNull()
    expect(acc.copilotAnnotations).toEqual([])
  })
})

// ─── Event processing ───

describe("processAnthropicEvent", () => {
  test("processes message_start: extracts model and usage", () => {
    const acc = createAnthropicStreamAccumulator()
    processAnthropicEvent(
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
    processAnthropicEvent(
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
    processAnthropicEvent(
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

    expect(acc.currentToolCall).not.toBeNull()
    expect(acc.currentToolCall!.id).toBe("tu_123")
    expect(acc.currentToolCall!.name).toBe("search")
    expect(acc.currentBlockType).toBe("tool_use")
  })

  test("processes content_block_start server_tool_use", () => {
    const acc = createAnthropicStreamAccumulator()
    processAnthropicEvent(
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

    expect(acc.currentToolCall).not.toBeNull()
    expect(acc.currentToolCall!.blockType).toBe("server_tool_use")
    expect(acc.currentBlockType).toBe("server_tool_use")
  })

  test("processes content_block_delta text_delta: accumulates content", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.currentBlockType = "text"

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      } as any,
      acc,
    )

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      } as any,
      acc,
    )

    expect(acc.content).toBe("Hello world!")
  })

  test("processes content_block_delta input_json_delta: accumulates tool input", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.currentToolCall = { id: "tu_1", name: "search", input: "", blockType: "tool_use" }

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      } as any,
      acc,
    )

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"test"}' },
      } as any,
      acc,
    )

    expect(acc.currentToolCall.input).toBe('{"query":"test"}')
  })

  test("processes content_block_delta thinking_delta: accumulates thinkingContent", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.currentBlockType = "thinking"

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think " },
      } as any,
      acc,
    )

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "about this..." },
      } as any,
      acc,
    )

    expect(acc.thinkingContent).toBe("Let me think about this...")
  })

  test("processes content_block_stop: finalizes tool call", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.currentToolCall = { id: "tu_1", name: "search", input: '{"q":"test"}', blockType: "tool_use" }

    processAnthropicEvent(
      {
        type: "content_block_stop",
        index: 0,
      } as any,
      acc,
    )

    expect(acc.currentToolCall).toBeNull()
    expect(acc.toolCalls).toHaveLength(1)
    expect(acc.toolCalls[0].id).toBe("tu_1")
    expect(acc.toolCalls[0].input).toBe('{"q":"test"}')
  })

  test("processes message_delta: sets stopReason and output usage", () => {
    const acc = createAnthropicStreamAccumulator()

    processAnthropicEvent(
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
    processAnthropicEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
      } as any,
      acc,
    )
    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":"a"}' },
      } as any,
      acc,
    )
    processAnthropicEvent({ type: "content_block_stop", index: 0 } as any, acc)

    // Second tool
    processAnthropicEvent(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_2", name: "read", input: {} },
      } as any,
      acc,
    )
    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"f":"b"}' },
      } as any,
      acc,
    )
    processAnthropicEvent({ type: "content_block_stop", index: 1 } as any, acc)

    expect(acc.toolCalls).toHaveLength(2)
    expect(acc.toolCalls[0].id).toBe("tu_1")
    expect(acc.toolCalls[1].id).toBe("tu_2")
  })

  test("ignores message_stop events gracefully", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.content = "preserved"

    processAnthropicEvent(
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

    processAnthropicEvent(
      {
        type: "ping",
      } as any,
      acc,
    )

    expect(acc.content).toBe("preserved")
  })

  test("collects copilot annotations from deltas", () => {
    const acc = createAnthropicStreamAccumulator()

    processAnthropicEvent(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "code" },
        copilot_annotations: {
          IPCodeCitations: [{ url: "https://github.com/repo", license: "MIT" }],
        },
      } as any,
      acc,
    )

    expect(acc.copilotAnnotations).toHaveLength(1)
    expect(acc.copilotAnnotations[0].IPCodeCitations![0].url).toBe("https://github.com/repo")
  })
})
