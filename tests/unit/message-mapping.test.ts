/**
 * Unit tests for message mapping utilities.
 *
 * Split from: characterization/retry-loop.test.ts
 * Tests: buildMessageMapping, messagesMatch
 */

import { describe, expect, test } from "bun:test"

import { buildMessageMapping, messagesMatch } from "~/lib/anthropic/message-mapping"

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
})
