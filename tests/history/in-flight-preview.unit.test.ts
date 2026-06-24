/**
 * extractPreviewText: faithfully summarize the LAST message (not a hunt-back
 * for the most recent user message). Mirrors the History-UI principle —
 * "if the last message is a tool_result, show [tool_result: id]; text first,
 * then tool_use".
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { extractPreviewText } from "~/lib/history/in-flight"

/** Minimal HistoryEntry whose inbound messages are the given array. */
function entryWith(messages: Array<unknown>): HistoryEntry {
  return {
    id: "e",
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: {
      model: "claude-sonnet-4.6",
      messages: messages as unknown as HistoryEntry["inboundRequest"]["messages"],
    },
  }
}

describe("extractPreviewText (last-message faithful)", () => {
  test("returns empty string when no messages", () => {
    expect(extractPreviewText(entryWith([]))).toBe("")
  })

  test("last message is user text → that text", () => {
    const entry = entryWith([
      { role: "user", content: "first question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "the latest question" },
    ])
    expect(extractPreviewText(entry)).toBe("the latest question")
  })

  test("last message is assistant text → that text (NOT a hunt-back to the earlier user message)", () => {
    const entry = entryWith([
      { role: "user", content: "the user asked this" },
      { role: "assistant", content: "the assistant replied this" },
    ])
    expect(extractPreviewText(entry)).toBe("the assistant replied this")
  })

  test("last message is an Anthropic tool_result block → [tool_result: id] (NOT the earlier user text)", () => {
    const entry = entryWith([
      { role: "user", content: "please run the Read tool" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] },
    ])
    expect(extractPreviewText(entry)).toBe("[tool_result: toolu_1]")
  })

  test("last message is an OpenAI role:tool message → [tool_result: call_id]", () => {
    const entry = entryWith([
      { role: "user", content: "earlier user text" },
      { role: "tool", tool_call_id: "call_abc", content: "tool output" },
    ])
    expect(extractPreviewText(entry)).toBe("[tool_result: call_abc]")
  })

  test("assistant message with OpenAI tool_calls → [tool_call: names]", () => {
    const entry = entryWith([
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "Read", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "Write", arguments: "{}" } },
        ],
      },
    ])
    expect(extractPreviewText(entry)).toBe("[tool_call: Read, Write]")
  })

  test("array content prefers a text block over a tool_use block", () => {
    const entry = entryWith([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_9", name: "Bash", input: {} },
          { type: "text", text: "here is the explanation" },
        ],
      },
    ])
    expect(extractPreviewText(entry)).toBe("here is the explanation")
  })

  test("array content with only a tool_use block → [tool_use: name]", () => {
    const entry = entryWith([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Glob", input: {} }] },
    ])
    expect(extractPreviewText(entry)).toBe("[tool_use: Glob]")
  })

  test("slices to 100 chars", () => {
    const long = "x".repeat(250)
    const entry = entryWith([{ role: "user", content: long }])
    expect(extractPreviewText(entry)).toBe("x".repeat(100))
  })

  test("falls back to a previous non-empty message when the last is empty", () => {
    const entry = entryWith([
      { role: "user", content: "the real question" },
      { role: "assistant", content: "" },
      { role: "user", content: "" },
    ])
    expect(extractPreviewText(entry)).toBe("the real question")
  })
})
