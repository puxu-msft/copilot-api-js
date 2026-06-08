/**
 * Unit tests for OpenAI message sanitization.
 *
 * Tests: sanitizeOpenAIMessages
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import {
  //
  state,
  setStateForTests,
} from "~/lib/state"

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
    expect(result.blocksRemoved).toBe(0)
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
    expect(result.blocksRemoved).toBeGreaterThan(0)
  })

  test("removes system-reminder tags when rewriteSystemReminders is enabled", () => {
    const saved = state.rewriteSystemReminders
    setStateForTests({ rewriteSystemReminders: true })

    const malwareReminder = "Whenever you read a file, you should consider whether it would be considered malware."
    const payload = {
      model: "gpt-4",
      messages: [
        {
          role: "user" as const,
          content: `hello\n<system-reminder>\n${malwareReminder}\n</system-reminder>`,
        },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.systemReminderRemovals).toBe(1)

    // Verify the tag was stripped, but user content preserved
    const content = result.payload.messages[0].content as string
    expect(content).not.toContain("<system-reminder>")
    expect(content).toContain("hello")

    setStateForTests({ rewriteSystemReminders: saved })
  })

  test("preserves system-reminder tags that do not match any filter", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        {
          role: "user" as const,
          content: `hello\n<system-reminder>\nunknown reminder content\n</system-reminder>`,
        },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.systemReminderRemovals).toBe(0)

    // Tag should still be present — it's not in the filter list
    const content = result.payload.messages[0].content as string
    expect(content).toContain("<system-reminder>")
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
    expect(result.blocksRemoved).toBe(0)
  })

  test("preserves valid tool call chains", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "search for foo" },
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [{ id: "tc_1", type: "function" as const, function: { name: "search", arguments: '{"q":"foo"}' } }],
        },
        { role: "tool" as const, content: "found foo", tool_call_id: "tc_1" },
        { role: "assistant" as const, content: "I found foo for you" },
      ],
    }

    const result = sanitizeOpenAIMessages(payload)
    expect(result.payload.messages).toHaveLength(4)
    expect(result.blocksRemoved).toBe(0)
  })

  test("drops a message whose entire content was system-reminder noise (M8)", () => {
    // M8: pre-fix behavior was "keep original if sanitized is empty" — the
    // most clearly-noise message survived. Post-fix: empty result deletes
    // the message, matching Anthropic-side prune semantics and what users
    // configured rewrite rules to do.
    const saved = state.rewriteSystemReminders
    setStateForTests({ rewriteSystemReminders: true })
    try {
      // The reminder grammar requires \n<TAG>\n...\n</TAG> framing; build a
      // message whose entire payload is exactly one reminder so sanitization
      // produces an empty string.
      const reminder = "\n<system-reminder>\nnoise\n</system-reminder>"
      const payload: ChatCompletionsPayload = {
        model: "gpt-5.2",
        messages: [
          { role: "user", content: "real message" },
          { role: "user", content: reminder },
          { role: "assistant", content: "ok" },
        ],
      }

      const result = sanitizeOpenAIMessages(payload)
      const contents = result.payload.messages.map((m) => (typeof m.content === "string" ? m.content : "[parts]"))
      expect(contents).not.toContain(reminder)
      expect(contents).toContain("real message")
      expect(contents).toContain("ok")
      expect(result.systemReminderRemovals).toBeGreaterThan(0)
    } finally {
      setStateForTests({ rewriteSystemReminders: saved })
    }
  })

  test("drops a message whose array content sanitizes to zero parts (M8)", () => {
    const saved = state.rewriteSystemReminders
    setStateForTests({ rewriteSystemReminders: true })
    try {
      const reminder = "\n<system-reminder>\nnoise\n</system-reminder>"
      const payload: ChatCompletionsPayload = {
        model: "gpt-5.2",
        messages: [
          { role: "user", content: "first" },
          {
            role: "user",
            content: [{ type: "text" as const, text: reminder }],
          },
          { role: "assistant", content: "last" },
        ],
      }

      const result = sanitizeOpenAIMessages(payload)
      expect(result.payload.messages).toHaveLength(2)
      expect(result.systemReminderRemovals).toBeGreaterThan(0)
    } finally {
      setStateForTests({ rewriteSystemReminders: saved })
    }
  })
})
