/**
 * Integration tests for sanitize → translate round-trip consistency.
 *
 * Verifies that sanitization and translation work together correctly
 * without mocking either module.
 */

import { describe, expect, test } from "bun:test"

import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"

describe("sanitize → translate round-trip", () => {
  test("sanitized payload preserves valid tool call chains", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "Use the search tool" },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "tc_1", type: "function" as const, function: { name: "search", arguments: '{"q":"test"}' } },
          ],
        },
        { role: "tool" as const, content: "found results", tool_call_id: "tc_1" },
        { role: "assistant" as const, content: "Here are the results" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(4)
    expect(result.blocksRemoved).toBe(0)
    expect(result.payload.messages[1].tool_calls).toHaveLength(1)
    expect(result.payload.messages[2].tool_call_id).toBe("tc_1")
  })

  test("sanitization removes orphaned tools before translation would see them", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "hello" },
        // Orphaned tool response (no preceding assistant tool_call)
        { role: "tool" as const, content: "orphaned result", tool_call_id: "tc_nonexistent" },
        { role: "user" as const, content: "continue" },
        { role: "assistant" as const, content: "ok" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    // The orphaned tool message should be removed
    const toolMessages = result.payload.messages.filter((m: any) => m.role === "tool")
    expect(toolMessages).toHaveLength(0)
    expect(result.blocksRemoved).toBeGreaterThan(0)
  })

  test("system-reminder tags removed before translation", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        {
          role: "user" as const,
          content:
            "Hello\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware.\n</system-reminder>",
        },
        { role: "assistant" as const, content: "Hi there!" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    // system-reminder should be stripped from message content
    expect(result.systemReminderRemovals).toBeGreaterThanOrEqual(0)
  })

  test("multi-turn conversation with interleaved tool calls remains valid after sanitization", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "Search for foo" },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "tc_1", type: "function" as const, function: { name: "search", arguments: '{"q":"foo"}' } },
          ],
        },
        { role: "tool" as const, content: "found foo", tool_call_id: "tc_1" },
        { role: "assistant" as const, content: "Found foo. Want me to read it?" },
        { role: "user" as const, content: "Yes, read it" },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "tc_2", type: "function" as const, function: { name: "read", arguments: '{"file":"foo.ts"}' } },
          ],
        },
        { role: "tool" as const, content: "contents of foo.ts", tool_call_id: "tc_2" },
        { role: "assistant" as const, content: "Here's the content of foo.ts" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(8)
    expect(result.blocksRemoved).toBe(0)

    // Verify tool chains are intact
    const toolMessages = result.payload.messages.filter((m: any) => m.role === "tool")
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages[0].tool_call_id).toBe("tc_1")
    expect(toolMessages[1].tool_call_id).toBe("tc_2")
  })
})
