import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

function assistant(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "assistant", content } as unknown as MessageParam
}
function user(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "user", content } as unknown as MessageParam
}

type Block = { type: string } & Record<string, unknown>

/** Synthesized web_search assistant turn (mirrors synthesize.ts), all blocks in one assistant message. */
function webSearchTurn(id = "srvtoolu_abc", query = "anthropic tokenizer"): MessageParam {
  return assistant([
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: [{ type: "web_search_result", title: "Result", url: "https://example.com", encrypted_content: "", page_age: null }],
    },
    { type: "text", text: "answer" },
  ])
}

function payload(messages: Array<MessageParam>, tools?: Array<{ name: string }>): MessagesPayload {
  return { model: "claude-opus-4.8", max_tokens: 1024, messages, ...(tools && { tools }) } as unknown as MessagesPayload
}

describe("sanitizeAnthropicMessages × rewriteHistoryServerTools", () => {
  test("downgrade: no server_tool_use survives, and no assistant message carries a tool_result (#1 regression)", () => {
    setStateForTests({ rewriteHistoryServerTools: "downgrade" })
    const out = sanitizeAnthropicMessages(payload([user([{ type: "text", text: "search" }]), webSearchTurn()])).payload

    for (const msg of out.messages) {
      const content = msg.content
      if (typeof content === "string") continue
      for (const b of content as unknown as Array<Block>) {
        expect(b.type).not.toBe("server_tool_use")
        expect(b.type).not.toBe("web_search_tool_result")
        if (msg.role === "assistant") expect(b.type).not.toBe("tool_result")
      }
    }
  })

  test("downgrade: processToolBlocks does NOT treat the downgraded tool_use as an orphan", () => {
    setStateForTests({ rewriteHistoryServerTools: "downgrade" })
    const out = sanitizeAnthropicMessages(payload([webSearchTurn("srvtoolu_keep", "q")])).payload

    // tool_use (assistant) + tool_result (user) must both survive — the pairing
    // is intact after the rewrite, so neither is dropped as an orphan.
    const toolUses = out.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
      .filter((b) => b.type === "tool_use")
    const toolResults = out.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
      .filter((b) => b.type === "tool_result")
    expect(toolUses.length).toBe(1)
    expect(toolResults.length).toBe(1)
    expect(toolUses[0].id).toBe("srvtoolu_keep")
    expect(toolResults[0].tool_use_id).toBe("srvtoolu_keep")
  })

  test("false (default): server_tool_use is passed through unchanged", () => {
    setStateForTests({ rewriteHistoryServerTools: false })
    const out = sanitizeAnthropicMessages(payload([webSearchTurn("srvtoolu_pass")])).payload

    const serverToolUses = out.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
      .filter((b) => b.type === "server_tool_use")
    expect(serverToolUses.length).toBe(1)
    expect(serverToolUses[0].id).toBe("srvtoolu_pass")
  })

  test("reproduces the root-cause scenario: server_tool_use{web_search} echoed in history with downgraded tools", () => {
    // The bug: client sends WebSearch (a plain tool, no server type) but history
    // carries a synthesized server_tool_use{web_search}. With downgrade on, the
    // historical block becomes a plain tool_use, so upstream sees no orphaned
    // server tool reference.
    setStateForTests({ rewriteHistoryServerTools: "downgrade" })
    const messages = [user([{ type: "text", text: "find docs" }]), webSearchTurn("srvtoolu_root", "tokenizer offline"), user([{ type: "text", text: "继续" }])]
    const out = sanitizeAnthropicMessages(payload(messages, [{ name: "WebSearch" }])).payload

    const allBlocks = out.messages.flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
    expect(allBlocks.some((b) => b.type === "server_tool_use")).toBe(false)
    expect(allBlocks.some((b) => b.type === "web_search_tool_result")).toBe(false)
    // The downgraded tool_use survives (paired tool_result keeps it non-orphan)
    expect(allBlocks.some((b) => b.type === "tool_use" && b.id === "srvtoolu_root")).toBe(true)
  })

  test("downgrade composes with system_messages_sanitize without producing orphans", () => {
    setStateForTests({ rewriteHistoryServerTools: "downgrade", systemMessagesSanitize: "as_user" })
    const messages = [{ role: "system", content: "inline system note" } as unknown as MessageParam, webSearchTurn("srvtoolu_compose")]
    const out = sanitizeAnthropicMessages(payload(messages)).payload
    const allBlocks = out.messages.flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
    expect(allBlocks.some((b) => b.type === "server_tool_use")).toBe(false)
    // tool_use + tool_result pairing preserved
    expect(allBlocks.filter((b) => b.type === "tool_use").length).toBe(1)
    expect(allBlocks.filter((b) => b.type === "tool_result").length).toBe(1)
  })

  test("ordering: rewrite runs before processToolBlocks (downgraded result is not dropped)", () => {
    // If processToolBlocks ran first, it would see web_search_tool_result whose
    // server_tool_use pairing it tracks, but after rewrite the user-side
    // tool_result must still pair with the assistant tool_use. This asserts the
    // post-sanitize structure is internally consistent (no orphan drop).
    setStateForTests({ rewriteHistoryServerTools: "downgrade" })
    const out = sanitizeAnthropicMessages(payload([webSearchTurn("srvtoolu_order")])).payload
    const toolUseIds = new Set(
      out.messages
        .flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
        .filter((b) => b.type === "tool_use")
        .map((b) => b.id),
    )
    const resultRefs = out.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Array<Block>)))
      .filter((b) => b.type === "tool_result")
      .map((b) => b.tool_use_id)
    for (const ref of resultRefs) expect(toolUseIds.has(ref as string)).toBe(true)
  })
})
