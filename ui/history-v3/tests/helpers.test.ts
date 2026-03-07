/**
 * Tests for V3 history UI helper functions.
 * Verifies that getPreviewText, getMessageSummary, extractText
 * handle edge cases (undefined messages, OpenAI format, etc.)
 */
import { describe, expect, test } from "bun:test"

// We test the pure functions directly (they don't depend on Vue)
import { extractText, getMessageSummary, getPreviewText, getStatusClass } from "../src/composables/useHistoryStore"
import type { HistoryEntry } from "../src/types"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "test-1",
    sessionId: "session-1",
    timestamp: Date.now(),
    endpoint: "anthropic-messages",
    request: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
    ...overrides,
  } as HistoryEntry
}

// ═══ getPreviewText ═══

describe("getPreviewText", () => {
  test("returns empty string when messages is undefined", () => {
    const entry = makeEntry({ request: { model: "test" } as any })
    // messages is undefined — should NOT crash
    expect(getPreviewText(entry)).toBe("")
  })

  test("returns empty string when messages is empty array", () => {
    const entry = makeEntry({ request: { model: "test", messages: [], stream: false } })
    expect(getPreviewText(entry)).toBe("")
  })

  test("extracts text from last user message with Anthropic format", () => {
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "First question" }] },
          { role: "assistant", content: [{ type: "text", text: "Answer" }] },
          { role: "user", content: [{ type: "text", text: "Follow-up question" }] },
        ],
        stream: false,
      },
    })
    expect(getPreviewText(entry)).toBe("Follow-up question")
  })

  test("extracts text from OpenAI string content", () => {
    const entry = makeEntry({
      request: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello OpenAI" }],
        stream: false,
      },
    })
    expect(getPreviewText(entry)).toBe("Hello OpenAI")
  })

  test("truncates preview to 100 chars", () => {
    const longText = "A".repeat(200)
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [{ role: "user", content: longText }],
        stream: false,
      },
    })
    expect(getPreviewText(entry).length).toBe(100)
  })

  test("falls back to last message when no user message", () => {
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [{ role: "assistant", content: "Just an assistant" }],
        stream: false,
      },
    })
    expect(getPreviewText(entry)).toBe("Just an assistant")
  })

  test("skips OpenAI tool response messages (role=tool) to find user message", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      request: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "Calculate something" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "calc", arguments: "{}" } }],
          },
          { role: "tool", content: "42", tool_call_id: "call_1" },
        ],
        stream: false,
      },
    })
    expect(getPreviewText(entry)).toBe("Calculate something")
  })

  test("shows tool_call name when only assistant tool_calls exist", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      request: {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
          },
        ],
        stream: false,
      },
    })
    const preview = getPreviewText(entry)
    expect(preview).toContain("tool_call")
    expect(preview).toContain("web_search")
  })

  test("shows tool_result when last message is role=tool", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      request: {
        model: "gpt-4o",
        messages: [{ role: "tool", content: "result", tool_call_id: "call_1" }],
        stream: false,
      },
    })
    const preview = getPreviewText(entry)
    expect(preview).toContain("tool_result")
    expect(preview).toContain("call_1")
  })

  test("skips Anthropic user messages with only tool_result blocks", () => {
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "Original question" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file data" }] },
        ],
        stream: false,
      },
    })
    expect(getPreviewText(entry)).toBe("Original question")
  })
})

// ═══ getMessageSummary ═══

describe("getMessageSummary", () => {
  test("returns 0 msg when messages is undefined", () => {
    const entry = makeEntry({ request: { model: "test" } as any })
    // messages is undefined — should NOT crash
    expect(getMessageSummary(entry)).toBe("0 msg")
  })

  test("counts messages and tool uses", () => {
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "1", name: "test", input: {} }] },
          { role: "user", content: "follow up" },
        ],
        stream: false,
      },
    })
    expect(getMessageSummary(entry)).toBe("3 msg, 1 tool")
  })

  test("handles empty messages array", () => {
    const entry = makeEntry({ request: { model: "test", messages: [], stream: false } })
    expect(getMessageSummary(entry)).toBe("0 msg")
  })

  test("counts OpenAI-style tool_calls", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      request: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "search for cats" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }],
          },
          { role: "tool", content: "cats found", tool_call_id: "call_1" },
        ],
        stream: false,
      },
    })
    expect(getMessageSummary(entry)).toBe("3 msg, 1 tool")
  })

  test("counts both Anthropic tool_use and OpenAI tool_calls in mixed conversations", () => {
    const entry = makeEntry({
      request: {
        model: "test",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_2", type: "function", function: { name: "Write", arguments: "{}" } }],
          },
        ],
        stream: false,
      },
    })
    expect(getMessageSummary(entry)).toBe("3 msg, 2 tool")
  })
})

// ═══ extractText ═══

describe("extractText", () => {
  test("extracts from string content", () => {
    expect(extractText("Hello world")).toBe("Hello world")
  })

  test("extracts from Anthropic text blocks", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ]
    expect(extractText(content as any)).toBe("Hello world")
  })

  test("extracts tool_use name", () => {
    const content = [{ type: "tool_use", id: "1", name: "my_tool", input: {} }]
    expect(extractText(content as any)).toBe("[Tool: my_tool]")
  })

  test("handles non-array non-string input", () => {
    expect(extractText(null as any)).toBe("")
    expect(extractText(undefined as any)).toBe("")
    expect(extractText(123 as any)).toBe("")
  })

  test("extracts thinking text", () => {
    const content = [{ type: "thinking", thinking: "Let me think..." }]
    expect(extractText(content as any)).toBe("Let me think...")
  })
})

// ═══ getStatusClass ═══

describe("getStatusClass", () => {
  test("returns pending when no response", () => {
    const entry = makeEntry()
    expect(getStatusClass(entry)).toBe("pending")
  })

  test("returns success when response.success is true", () => {
    const entry = makeEntry({
      response: {
        success: true,
        model: "test",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: null,
      },
    })
    expect(getStatusClass(entry)).toBe("success")
  })

  test("returns error when response.success is false", () => {
    const entry = makeEntry({
      response: {
        success: false,
        model: "test",
        usage: { input_tokens: 10, output_tokens: 0 },
        error: "Rate limited",
        content: null,
      },
    })
    expect(getStatusClass(entry)).toBe("error")
  })
})
