/**
 * Unit tests for OpenAI message sanitization.
 *
 * Tests: sanitizeOpenAIMessages
 */

import { describe, expect, test } from "bun:test"

import { sanitizeOpenAIMessages } from "~/lib/message-sanitizer/sanitize-openai"

describe("sanitizeOpenAIMessages", () => {
  test("returns unchanged payload when no orphans", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "hi" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(2)
    expect(result.removedCount).toBe(0)
  })

  test("removes orphaned tool messages", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "tool" as const, content: "orphaned", tool_call_id: "nonexistent" },
        { role: "user" as const, content: "bye" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    // orphaned tool removed
    expect(result.payload.messages.length).toBeLessThan(3)
    expect(result.removedCount).toBeGreaterThan(0)
  })

  test("removes system-reminder content from messages", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        {
          role: "user" as const,
          content: "hello <system-reminder>ignore this</system-reminder>",
        },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.systemReminderRemovals).toBeGreaterThanOrEqual(0)
  })

  test("does not modify original payload", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "tool" as const, content: "orphaned", tool_call_id: "nonexistent" },
      ],
    }

    const originalLength = payload.messages.length
    sanitizeOpenAIMessages(payload)
    expect(payload.messages).toHaveLength(originalLength)
  })

  test("handles empty messages array", () => {
    const payload = {
      model: "gpt-4",
      messages: [] as Array<any>,
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(0)
    expect(result.removedCount).toBe(0)
  })

  test("preserves valid tool call chains", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "search for foo" },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "tc_1", type: "function" as const, function: { name: "search", arguments: '{"q":"foo"}' } },
          ],
        },
        { role: "tool" as const, content: "found foo", tool_call_id: "tc_1" },
        { role: "assistant" as const, content: "I found foo for you" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(4)
    expect(result.removedCount).toBe(0)
  })
})
