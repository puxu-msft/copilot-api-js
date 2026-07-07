/**
 * Unit tests for message mapping utilities.
 *
 * Split from: characterization/retry-loop.test.ts
 * Tests: buildMessageMapping, messagesMatch
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  buildMessageMapping,
  messagesMatch,
} from "~/lib/anthropic/message-mapping"

/** Cast a loose fixture array to MessageParam[] (server_tool_use literals don't fit the narrow SDK union). */
function asMessages(messages: Array<unknown>): Array<MessageParam> {
  return messages as Array<MessageParam>
}
/** Cast a loose fixture to MessageParam. */
function asMessage(message: unknown): MessageParam {
  return message as MessageParam
}

// ─── buildMessageMapping ───

describe("buildMessageMapping", () => {
  test("maps identical arrays 1:1", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
      { role: "user" as const, content: "Bye" },
    ]
    const mapping = buildMessageMapping(messages, messages)
    expect(mapping).toEqual([0, 1, 2])
  })

  test("maps rewritten (subset) to original indices", () => {
    const original = [
      { role: "user" as const, content: "msg-0" },
      { role: "assistant" as const, content: "msg-1" },
      { role: "user" as const, content: "msg-2" },
      { role: "assistant" as const, content: "msg-3" },
      { role: "user" as const, content: "msg-4" },
    ]
    // Removed msg-1 and msg-2
    const rewritten = [
      { role: "user" as const, content: "msg-0" },
      { role: "assistant" as const, content: "msg-3" },
      { role: "user" as const, content: "msg-4" },
    ]
    const mapping = buildMessageMapping(original, rewritten)
    expect(mapping).toEqual([0, 3, 4])
  })

  test("handles empty rewritten array", () => {
    const original = [{ role: "user" as const, content: "Hello" }]
    const mapping = buildMessageMapping(original, [])
    expect(mapping).toEqual([])
  })

  test("handles empty original array", () => {
    const mapping = buildMessageMapping([], [])
    expect(mapping).toEqual([])
  })

  test("maps a split turn (1 original → 2 rewritten) back to the source original index", () => {
    // rewriteServerToolBlocks splits one assistant (server_tool_use + result + text)
    // into assistant(tool_use + text) + a NEW user(tool_result). Both derive from
    // the single original assistant, so both must map to its index.
    const original = [
      { role: "user" as const, content: "search" },
      {
        role: "assistant" as const,
        content: [
          { type: "server_tool_use" as const, id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result" as const, tool_use_id: "srvtoolu_1", content: [] },
          { type: "text" as const, text: "answer" },
        ],
      },
    ]
    const rewritten = [
      { role: "user" as const, content: "search" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
          { type: "text" as const, text: "answer" },
        ],
      },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "srvtoolu_1", content: "answer" }] },
    ]
    const mapping = buildMessageMapping(asMessages(original), asMessages(rewritten))
    expect(mapping).toEqual([0, 1, 1])
  })

  test("split combined with a deletion still maps correctly", () => {
    const original = [
      { role: "user" as const, content: "m0" },
      { role: "user" as const, content: "m1-removed" },
      {
        role: "assistant" as const,
        content: [
          { type: "server_tool_use" as const, id: "s2", name: "web_search", input: {} },
          { type: "web_search_tool_result" as const, tool_use_id: "s2", content: [] },
        ],
      },
    ]
    const rewritten = [
      { role: "user" as const, content: "m0" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "s2", name: "web_search", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "s2", content: "" }] },
    ]
    // m0 → 0; split assistant → 2 (m1 deleted); split-out user → 2 (same source)
    const mapping = buildMessageMapping(asMessages(original), asMessages(rewritten))
    expect(mapping).toEqual([0, 2, 2])
  })
})

// ─── messagesMatch ───

describe("messagesMatch", () => {
  test("matches identical string content messages", () => {
    const msg = { role: "user" as const, content: "Hello world" }
    expect(messagesMatch(msg, msg)).toBe(true)
  })

  test("does not match different roles", () => {
    const a = { role: "user" as const, content: "Hello" }
    const b = { role: "assistant" as const, content: "Hello" }
    expect(messagesMatch(a, b)).toBe(false)
  })

  test("matches by prefix for string content", () => {
    const orig = { role: "user" as const, content: "Hello world, this is a long message" }
    const rewritten = { role: "user" as const, content: "Hello world, this is a long message (modified)" }
    // messagesMatch uses prefix comparison (first 100 chars)
    expect(messagesMatch(orig, rewritten)).toBe(true)
  })

  test("matches tool_use blocks by id", () => {
    const orig = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "tu_123", name: "search", input: {} }],
    }
    const rewritten = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "tu_123", name: "search", input: { q: "modified" } }],
    }
    expect(messagesMatch(orig, rewritten)).toBe(true)
  })

  test("does not match tool_use blocks with different ids", () => {
    const orig = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "tu_123", name: "search", input: {} }],
    }
    const rewritten = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "tu_456", name: "search", input: {} }],
    }
    expect(messagesMatch(orig, rewritten)).toBe(false)
  })

  test("matches tool_result blocks by tool_use_id", () => {
    const orig = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "tu_123", content: "result text" }],
    }
    const rewritten = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: "tu_123", content: "different result" }],
    }
    expect(messagesMatch(orig, rewritten)).toBe(true)
  })

  test("matches when both have empty content arrays", () => {
    const orig = { role: "user" as const, content: [] as Array<any> }
    const rewritten = { role: "user" as const, content: [] as Array<any> }
    expect(messagesMatch(orig, rewritten)).toBe(true)
  })

  test("matches a downgraded server_tool_use against the original tool_use by id", () => {
    // rewriteServerToolBlocks turns server_tool_use into a plain tool_use; the
    // mapping must still recognize the assistant as the same original message.
    const orig = {
      role: "assistant" as const,
      content: [{ type: "server_tool_use" as const, id: "srvtoolu_1", name: "web_search", input: {} }],
    }
    const rewritten = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "srvtoolu_1", name: "web_search", input: {} }],
    }
    expect(messagesMatch(asMessage(orig), asMessage(rewritten))).toBe(true)
  })

  test("does not match a downgraded server_tool_use against a different id", () => {
    const orig = {
      role: "assistant" as const,
      content: [{ type: "server_tool_use" as const, id: "srvtoolu_1", name: "web_search", input: {} }],
    }
    const rewritten = {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "srvtoolu_2", name: "web_search", input: {} }],
    }
    expect(messagesMatch(asMessage(orig), asMessage(rewritten))).toBe(false)
  })
})
