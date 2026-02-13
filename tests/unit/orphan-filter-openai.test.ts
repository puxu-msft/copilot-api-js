/**
 * Unit tests for OpenAI orphan filtering functions.
 *
 * Tests: getOpenAIToolCallIds, getOpenAIToolResultIds,
 *        filterOpenAIOrphanedToolResults, filterOpenAIOrphanedToolUse,
 *        ensureOpenAIStartsWithUser, extractOpenAISystemMessages
 */

import { describe, expect, test } from "bun:test"

import {
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
  getOpenAIToolCallIds,
  getOpenAIToolResultIds,
} from "~/lib/openai/orphan-filter"

// ─── getOpenAIToolCallIds ───

describe("getOpenAIToolCallIds", () => {
  test("returns tool_call ids from assistant message", () => {
    const msg = {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        { id: "tc_1", type: "function" as const, function: { name: "search", arguments: "{}" } },
        { id: "tc_2", type: "function" as const, function: { name: "read", arguments: "{}" } },
      ],
    }
    expect(getOpenAIToolCallIds(msg)).toEqual(["tc_1", "tc_2"])
  })

  test("returns empty array for non-assistant message", () => {
    const msg = { role: "user" as const, content: "hello" }
    expect(getOpenAIToolCallIds(msg)).toEqual([])
  })

  test("returns empty array for assistant without tool_calls", () => {
    const msg = { role: "assistant" as const, content: "hello" }
    expect(getOpenAIToolCallIds(msg)).toEqual([])
  })
})

// ─── getOpenAIToolResultIds ───

describe("getOpenAIToolResultIds", () => {
  test("collects tool_call_ids from tool messages", () => {
    const messages = [
      { role: "tool" as const, content: "result 1", tool_call_id: "tc_1" },
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, content: "result 2", tool_call_id: "tc_2" },
    ]
    const ids = getOpenAIToolResultIds(messages)
    expect(ids.has("tc_1")).toBe(true)
    expect(ids.has("tc_2")).toBe(true)
    expect(ids.size).toBe(2)
  })

  test("returns empty set when no tool messages", () => {
    const messages = [{ role: "user" as const, content: "hello" }]
    expect(getOpenAIToolResultIds(messages).size).toBe(0)
  })
})

// ─── filterOpenAIOrphanedToolResults ───

describe("filterOpenAIOrphanedToolResults", () => {
  test("keeps tool message with matching assistant tool_call", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ id: "tc_1", type: "function" as const, function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool" as const, content: "result", tool_call_id: "tc_1" },
    ]
    const filtered = filterOpenAIOrphanedToolResults(messages)
    expect(filtered).toHaveLength(2)
  })

  test("removes tool message without matching assistant tool_call", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, content: "orphaned result", tool_call_id: "tc_nonexistent" },
    ]
    const filtered = filterOpenAIOrphanedToolResults(messages)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].role).toBe("user")
  })

  test("keeps non-tool messages unchanged", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    const filtered = filterOpenAIOrphanedToolResults(messages)
    expect(filtered).toHaveLength(2)
  })
})

// ─── filterOpenAIOrphanedToolUse ───

describe("filterOpenAIOrphanedToolUse", () => {
  test("keeps tool_calls with matching tool responses", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ id: "tc_1", type: "function" as const, function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool" as const, content: "result", tool_call_id: "tc_1" },
    ]
    const filtered = filterOpenAIOrphanedToolUse(messages)
    expect(filtered).toHaveLength(2)
    expect(filtered[0].tool_calls).toHaveLength(1)
  })

  test("removes orphaned tool_calls without matching tool response", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "some text",
        tool_calls: [{ id: "tc_orphan", type: "function" as const, function: { name: "search", arguments: "{}" } }],
      },
    ]
    const filtered = filterOpenAIOrphanedToolUse(messages)
    // Should keep message (has content) but remove tool_calls
    expect(filtered).toHaveLength(1)
    expect(filtered[0].tool_calls).toBeUndefined()
  })

  test("drops assistant message entirely if no content and all tool_calls orphaned", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [{ id: "tc_orphan", type: "function" as const, function: { name: "search", arguments: "{}" } }],
      },
    ]
    const filtered = filterOpenAIOrphanedToolUse(messages)
    expect(filtered).toHaveLength(0)
  })

  test("handles assistant with multiple tool_calls, some orphaned", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          { id: "tc_1", type: "function" as const, function: { name: "search", arguments: "{}" } },
          { id: "tc_orphan", type: "function" as const, function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool" as const, content: "result", tool_call_id: "tc_1" },
    ]
    const filtered = filterOpenAIOrphanedToolUse(messages)
    expect(filtered[0].tool_calls).toHaveLength(1)
    expect(filtered[0].tool_calls![0].id).toBe("tc_1")
  })
})

// ─── ensureOpenAIStartsWithUser ───

describe("ensureOpenAIStartsWithUser", () => {
  test("returns unchanged when starts with user", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    expect(ensureOpenAIStartsWithUser(messages)).toHaveLength(2)
  })

  test("skips leading non-user messages", () => {
    const messages = [
      { role: "assistant" as const, content: "stale" },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    const result = ensureOpenAIStartsWithUser(messages)
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe("user")
  })

  test("returns empty when no user messages", () => {
    const messages = [{ role: "assistant" as const, content: "stale" }]
    expect(ensureOpenAIStartsWithUser(messages)).toHaveLength(0)
  })
})

// ─── extractOpenAISystemMessages ───

describe("extractOpenAISystemMessages", () => {
  test("splits system messages from conversation", () => {
    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0].role).toBe("system")
    expect(conversationMessages).toHaveLength(2)
  })

  test("includes developer messages as system", () => {
    const messages = [
      { role: "system" as const, content: "System instruction" },
      { role: "developer" as const, content: "Developer instruction" },
      { role: "user" as const, content: "hello" },
    ]
    const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
    expect(systemMessages).toHaveLength(2)
    expect(conversationMessages).toHaveLength(1)
  })

  test("returns empty system when starts with user", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ]
    const { systemMessages, conversationMessages } = extractOpenAISystemMessages(messages)
    expect(systemMessages).toHaveLength(0)
    expect(conversationMessages).toHaveLength(2)
  })
})
