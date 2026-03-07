/**
 * Tests for Responses API input/output conversion helpers.
 *
 * Verifies that responsesInputToMessages and responsesOutputToContent correctly
 * convert between Responses API format and the unified MessageContent format
 * used by the history system.
 */

import { describe, expect, test } from "bun:test"

import type { ResponsesInputItem, ResponsesOutputItem } from "~/types/api/openai-responses"

import { responsesInputToMessages, responsesOutputToContent } from "~/lib/openai/responses-conversion"

// ============================================================================
// responsesInputToMessages
// ============================================================================

describe("responsesInputToMessages", () => {
  test("converts string input to single user message", () => {
    const result = responsesInputToMessages("Hello world")
    expect(result).toEqual([{ role: "user", content: "Hello world" }])
  })

  test("converts message input item with string content", () => {
    const input: Array<ResponsesInputItem> = [{ type: "message", role: "user", content: "How are you?" }]
    const result = responsesInputToMessages(input)
    expect(result).toEqual([{ role: "user", content: "How are you?" }])
  })

  test("converts message input with input_text content parts", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What is this?" }],
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
    expect(result[0].content).toEqual([{ type: "text", text: "What is this?" }])
  })

  test("converts message input with output_text content parts", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Here is my response" }],
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toEqual([{ type: "text", text: "Here is my response" }])
  })

  test("converts input_image content parts", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://example.com/img.png" }],
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result[0].content).toEqual([{ type: "image", source: { type: "url", url: "https://example.com/img.png" } }])
  })

  test("converts function_call input to assistant tool_calls", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"Tokyo"}',
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
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

  test("converts function_call_output to tool response", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: '{"temp":25}',
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: "tool",
      content: '{"temp":25}',
      tool_call_id: "call_abc",
    })
  })

  test("converts item_reference to system message", () => {
    const input: Array<ResponsesInputItem> = [{ type: "item_reference", id: "ref_123" }]
    const result = responsesInputToMessages(input)
    expect(result).toEqual([{ role: "system", content: "[item_reference: ref_123]" }])
  })

  test("converts mixed input items in order", () => {
    const input: Array<ResponsesInputItem> = [
      { type: "message", role: "user", content: "Calculate 2+2" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "calculator",
        arguments: '{"expr":"2+2"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "4" },
      { type: "message", role: "assistant", content: "The answer is 4." },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(4)
    expect(result[0].role).toBe("user")
    expect(result[1].role).toBe("assistant")
    expect(result[1].tool_calls).toHaveLength(1)
    expect(result[2].role).toBe("tool")
    expect(result[3].role).toBe("assistant")
    expect(result[3].content).toBe("The answer is 4.")
  })

  test("handles message without explicit type", () => {
    // Items without `type` should be treated as "message"
    const input: Array<ResponsesInputItem> = [{ role: "user", content: "No type field" } as any]
    const result = responsesInputToMessages(input)
    expect(result).toEqual([{ role: "user", content: "No type field" }])
  })

  // ── Reasoning and custom item types ──

  test("converts reasoning input item to assistant marker", () => {
    const input: Array<ResponsesInputItem> = [
      {
        type: "reasoning",
        id: "rs_abc",
        summary: [{ type: "summary_text", text: "I need to think about this" }],
        encrypted_content: "enc_data_here",
      },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toContain("reasoning")
    expect(result[0].content).toContain("rs_abc")
  })

  test("converts reasoning input item without id", () => {
    const input: Array<ResponsesInputItem> = [
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
    ]
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("assistant")
    expect(result[0].content).toContain("unknown")
  })

  test("converts unknown/compaction item type to system marker", () => {
    const input = [{ type: "compaction", id: "cmp_123", encrypted_content: "..." }] as Array<ResponsesInputItem>
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("system")
    expect(result[0].content).toContain("compaction")
    expect(result[0].content).toContain("cmp_123")
  })

  test("skips unknown item type without id", () => {
    const input = [{ type: "unknown_type" }] as Array<ResponsesInputItem>
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(0)
  })

  test("handles full conversation with reasoning and compaction items", () => {
    const input = [
      { type: "message", role: "user", content: "Hello" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc1" },
      { type: "message", role: "assistant", content: "Hi!" },
      { type: "compaction", id: "cmp_1", encrypted_content: "enc2" },
      { type: "message", role: "user", content: "What's next?" },
    ] as Array<ResponsesInputItem>
    const result = responsesInputToMessages(input)
    expect(result).toHaveLength(5)
    expect(result[0].role).toBe("user")
    expect(result[1].role).toBe("assistant") // reasoning
    expect(result[2].role).toBe("assistant") // response
    expect(result[3].role).toBe("system") // compaction
    expect(result[4].role).toBe("user")
  })
})

// ============================================================================
// responsesOutputToContent
// ============================================================================

describe("responsesOutputToContent", () => {
  test("returns null for empty output array", () => {
    expect(responsesOutputToContent([])).toBeNull()
  })

  test("extracts text from message output", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello there!", annotations: [] }],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result).toEqual({
      role: "assistant",
      content: "Hello there!",
    })
  })

  test("joins multiple text parts", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Part 1. ", annotations: [] },
          { type: "output_text", text: "Part 2.", annotations: [] },
        ],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.content).toBe("Part 1. Part 2.")
  })

  test("handles refusal content", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "I cannot help with that" }],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.content).toContain("Refusal")
    expect(result?.content).toContain("I cannot help with that")
  })

  test("extracts function_call as tool_calls", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"Tokyo"}',
        status: "completed",
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result).toEqual({
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

  test("combines text and function_calls in mixed output", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Let me search for that.", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "web_search",
        arguments: '{"query":"weather"}',
        status: "completed",
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.role).toBe("assistant")
    expect(result?.content).toBe("Let me search for that.")
    expect(result?.tool_calls).toHaveLength(1)
    expect(result?.tool_calls?.[0].function.name).toBe("web_search")
  })

  test("multiple function_calls", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "search",
        arguments: '{"q":"a"}',
        status: "completed",
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_2",
        name: "read_file",
        arguments: '{"path":"/tmp/x"}',
        status: "completed",
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.tool_calls).toHaveLength(2)
    expect(result?.tool_calls?.[0].function.name).toBe("search")
    expect(result?.tool_calls?.[1].function.name).toBe("read_file")
  })

  // ── Reasoning output items ──

  test("extracts reasoning output summary text", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [
          { type: "summary_text", text: "Step 1: analyze the problem" },
          { type: "summary_text", text: "Step 2: find solution" },
        ],
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done!", annotations: [] }],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.content).toContain("Done!")
    expect(result?.content).toContain("Reasoning")
    expect(result?.content).toContain("Step 1")
    expect(result?.content).toContain("Step 2")
  })

  test("handles reasoning output without summary", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "enc_data",
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello!", annotations: [] }],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.content).toContain("Hello!")
    // No reasoning text should be added when summary is empty
    expect(result?.content).not.toContain("Reasoning")
  })

  test("returns reasoning-only output when no text message", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Thinking about the problem..." }],
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result).not.toBeNull()
    expect(result?.content).toContain("Reasoning")
    expect(result?.content).toContain("Thinking about the problem...")
  })

  test("combines reasoning, text, and function_calls", () => {
    const output: Array<ResponsesOutputItem> = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "I should call the tool" }],
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Let me check.", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "search",
        arguments: '{"q":"test"}',
        status: "completed",
      },
    ]
    const result = responsesOutputToContent(output)
    expect(result?.content).toContain("Reasoning")
    expect(result?.content).toContain("Let me check.")
    expect(result?.tool_calls).toHaveLength(1)
    expect(result?.tool_calls?.[0].function.name).toBe("search")
  })
})
