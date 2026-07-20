import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history/types"

import {
  //
  extractResponsePreviewText,
  summarizeResponseMessage,
} from "~/lib/history/entry-view"

describe("summarizeResponseMessage", () => {
  test("anthropic array content: tools first then text → [A, B] text", () => {
    const msg: MessageContent = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "1", name: "AskUserQuestion", input: {} },
        { type: "tool_use", id: "2", name: "Bash", input: {} },
      ],
    } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[AskUserQuestion, Bash] let me check")
  })

  test("string content + tool_calls (CC/Responses/Gemini shape)", () => {
    const msg = {
      role: "assistant",
      content: "done",
      tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }],
    } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[Read] done")
  })

  test("only text", () => {
    expect(summarizeResponseMessage({ role: "assistant", content: "hello" } as MessageContent)).toBe("hello")
  })

  test("only tools", () => {
    const msg = { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Grep", input: {} }] } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[Grep]")
  })

  test("empty → ''", () => {
    expect(summarizeResponseMessage({ role: "assistant", content: null } as MessageContent)).toBe("")
  })

  test("truncates to ~100 chars", () => {
    const long = "x".repeat(200)
    expect(summarizeResponseMessage({ role: "assistant", content: long } as MessageContent).length).toBeLessThanOrEqual(100)
  })

  test("server_tool_use block → [web_search]", () => {
    const msg = { role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] } as MessageContent
    expect(summarizeResponseMessage(msg)).toBe("[web_search]")
  })
})

describe("extractResponsePreviewText", () => {
  test("non-streaming body (anthropic)", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [
        { upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "AskUserQuestion", input: {} }] } } },
      ],
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("[AskUserQuestion]")
  })

  test("streaming forwarded frames (anthropic)", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ upstreamResponse: { success: true } }],
      clientResponse: {
        sseEvents: [
          { raw: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }) },
          { raw: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi there" } }) },
        ],
      },
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("hi there")
  })

  test("failed entry with no content → error fallback", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ error: "upstream 500", upstreamResponse: { success: false, body: null } }],
      _index: { derived: { failureReason: "upstream 500" } },
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("upstream 500")
  })

  // errorFallback 第 2 级：无 attempts[].error,退到 _index.derived.failureReason(截断 ~100)。
  test("errorFallback level 2: no attempts[].error → _index.derived.failureReason (truncated ~100)", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ upstreamResponse: { success: false } }],
      _index: { derived: { failureReason: "e".repeat(150) } },
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("e".repeat(100))
  })

  // errorFallback 第 3 级：无 error/failureReason,退到 finalUpstreamResponse().rawBody 首行(截断 ~100)。
  test("errorFallback level 3: no error/failureReason → first line of rawBody", () => {
    const entry = {
      endpoint: "anthropic-messages",
      attempts: [{ upstreamResponse: { success: false, rawBody: "boom: internal error\nstack line 1\nstack line 2" } }],
    } as unknown as HistoryEntry
    expect(extractResponsePreviewText(entry)).toBe("boom: internal error")
  })

  test("in-flight (no attempts) → ''", () => {
    expect(extractResponsePreviewText({ endpoint: "anthropic-messages" } as unknown as HistoryEntry)).toBe("")
  })
})
