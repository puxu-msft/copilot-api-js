/**
 * Unit tests for the leading-user-message legality used by auto-truncate cleanup.
 *
 * Anthropic requires messages[0] to be a LEGAL user turn: a user message that is
 * not a pure tool_result turn (whose tool_use was truncated away → orphaned).
 * These guard `ensureAnthropicStartsWithUser` and `cleanupMessages` so truncation
 * never ships a messages[0] the upstream rejects (`messages.0: use the top-level
 * 'system' parameter` / orphaned tool_result).
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
  ensureAnthropicStartsWithUser,
  isLegalLeadingUserMessage,
} from "~/lib/anthropic/message-tool-utils"
import { cleanupMessages } from "~/lib/anthropic/auto-truncate/truncation"

// Block builders
const text = (t: string) => ({ type: "text" as const, text: t })
const toolResult = (id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: "result" })
const toolUse = (id: string, name = "read") => ({ type: "tool_use" as const, id, name, input: {} })

const userText = (t: string): MessageParam => ({ role: "user", content: [text(t)] })
const userStr = (t: string): MessageParam => ({ role: "user", content: t })
const userToolResult = (id: string): MessageParam => ({ role: "user", content: [toolResult(id)] })
const userMixed = (id: string, t: string): MessageParam => ({ role: "user", content: [toolResult(id), text(t)] })
const assistant = (t: string): MessageParam => ({ role: "assistant", content: [text(t)] })
const assistantToolUse = (id: string): MessageParam => ({ role: "assistant", content: [toolUse(id)] })
const systemMsg = (t: string): MessageParam => ({ role: "system", content: t }) as unknown as MessageParam

describe("isLegalLeadingUserMessage", () => {
  test("string-content user is legal", () => {
    expect(isLegalLeadingUserMessage(userStr("hi"))).toBe(true)
  })

  test("user with text block is legal", () => {
    expect(isLegalLeadingUserMessage(userText("hi"))).toBe(true)
  })

  test("pure tool_result user turn is NOT legal (orphaned at messages[0])", () => {
    expect(isLegalLeadingUserMessage(userToolResult("toolu_1"))).toBe(false)
  })

  test("mixed user[tool_result, text] IS legal (not pure tool_result — must not be dropped)", () => {
    expect(isLegalLeadingUserMessage(userMixed("toolu_1", "hi"))).toBe(true)
  })

  test("assistant message is NOT legal as messages[0]", () => {
    expect(isLegalLeadingUserMessage(assistant("hi"))).toBe(false)
  })

  test("system message is NOT legal as messages[0]", () => {
    expect(isLegalLeadingUserMessage(systemMsg("sys"))).toBe(false)
  })

  test("empty-array user is NOT legal", () => {
    expect(isLegalLeadingUserMessage({ role: "user", content: [] })).toBe(false)
  })

  test("pure server_tool_result user turn is NOT legal (orphaned web_search result)", () => {
    const msg: MessageParam = {
      role: "user",
      content: [{ type: "web_search_tool_result" as const, tool_use_id: "srvtoolu_1", content: [] }],
    } as unknown as MessageParam
    expect(isLegalLeadingUserMessage(msg)).toBe(false)
  })

  test("empty-string user is legal (string content path) — not a truncation concern", () => {
    // Truncation never produces this (it only deletes, never blanks string content);
    // documents the boundary so a future change to the predicate is a conscious choice.
    expect(isLegalLeadingUserMessage(userStr(""))).toBe(true)
  })
})

describe("ensureAnthropicStartsWithUser (strengthened)", () => {
  test("skips leading pure-tool_result user + assistant, stops at user(text)", () => {
    const out = ensureAnthropicStartsWithUser([userToolResult("toolu_1"), assistant("a"), userText("real")])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(userText("real"))
  })

  test("keeps mixed user[tool_result,text] as the start (does not over-skip)", () => {
    const out = ensureAnthropicStartsWithUser([userMixed("toolu_1", "hi"), assistant("a")])
    expect(out).toHaveLength(2)
    expect(isLegalLeadingUserMessage(out[0])).toBe(true)
  })

  test("break semantics: stops at first legal user, preserves the rest verbatim", () => {
    const tail = [userText("first"), assistant("a"), systemMsg("mid"), userText("second")]
    const out = ensureAnthropicStartsWithUser([assistant("lead"), ...tail])
    expect(out).toEqual(tail) // only the leading assistant dropped; mid system preserved
  })

  test("string-content user is a valid start", () => {
    const out = ensureAnthropicStartsWithUser([userStr("hi"), assistant("a")])
    expect(out).toHaveLength(2)
  })
})

describe("cleanupMessages convergence", () => {
  test("orphaned leading tool_result + cut pairing → converges to legal user[0]", () => {
    // Truncation cut the assistant(tool_use toolu_1) away, leaving its user(tool_result)
    // orphaned at the front. A mid system message AFTER the legal start must be preserved.
    const messages: Array<MessageParam> = [
      userToolResult("toolu_1"), // orphan (tool_use gone) — dropped
      assistant("answer"), // leading non-user — dropped
      userText("next question"), // first LEGAL user → start here
      systemMsg("mid-system"), // after the start → must be preserved
      assistantToolUse("toolu_2"),
      userToolResult("toolu_2"), // paired — legal
    ]
    const out = cleanupMessages(messages)
    expect(out.length).toBeGreaterThan(0)
    expect(isLegalLeadingUserMessage(out[0])).toBe(true)
    expect(out[0]).toEqual(userText("next question"))
    // Mid system message (after the legal start) is preserved (Anthropic accepts non-leading system).
    expect(out.some((m) => m.role === "system")).toBe(true)
  })

  test("terminates (length stabilizes) and yields legal start or empty", () => {
    // All tool-result turns + assistant → nothing legal to start; converges to [].
    const messages: Array<MessageParam> = [userToolResult("a"), assistant("x"), userToolResult("b")]
    const out = cleanupMessages(messages)
    // Either empty or a legal user start — never an illegal messages[0].
    if (out.length > 0) expect(isLegalLeadingUserMessage(out[0])).toBe(true)
  })
})
