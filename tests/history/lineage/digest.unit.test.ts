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

import { computeLineageDigest } from "~/lib/history/lineage/digest"

/** Build a minimal HistoryEntry for testing. */
function makeEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "req_test_1",
    startedAt: 0,
    endpoint: "anthropic-messages",
    inboundRequest: {
      model: "claude-opus-4.7",
      messages: [],
    },
    ...over,
  }
}

describe("computeLineageDigest — null cases", () => {
  test("returns null for non-Anthropic endpoint (v1 scope)", () => {
    const entry = makeEntry({ endpoint: "openai-chat-completions" })
    expect(computeLineageDigest(entry)).toBeNull()
  })

  test("returns null when no messages", () => {
    const entry = makeEntry()
    expect(computeLineageDigest(entry)).toBeNull()
  })

  test("returns null when messages array is missing entirely", () => {
    const entry = makeEntry({ inboundRequest: { model: "x" } })
    expect(computeLineageDigest(entry)).toBeNull()
  })
})

describe("computeLineageDigest — basic shape", () => {
  test("returns a v=1 digest with correct turnHashes length and computedAt set", () => {
    const messages: Array<MessageContent> = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]
    const entry = makeEntry({ inboundRequest: { model: "x", messages } })
    const digest = computeLineageDigest(entry)

    expect(digest).not.toBeNull()
    expect(digest!.v).toBe(1)
    expect(digest!.turnHashes).toHaveLength(3)
    expect(digest!.rootHash).toMatch(/^[0-9a-f]{64}$/)
    expect(digest!.computedAt).toBeGreaterThan(0)
  })

  test("postResponseHash is null without outboundResponse (failed entry)", () => {
    const messages: Array<MessageContent> = [{ role: "user", content: "Q1" }]
    const entry = makeEntry({
      inboundRequest: { model: "x", messages },
      state: "failed",
    })
    const digest = computeLineageDigest(entry)
    expect(digest!.postResponseHash).toBeNull()
    expect(digest!.producedToolUseIds).toEqual([])
  })

  test("postResponseHash present when outboundResponse.content has assistant message", () => {
    const messages: Array<MessageContent> = [{ role: "user", content: "Q1" }]
    const entry = makeEntry({
      inboundRequest: { model: "x", messages },
      outboundResponse: {
        success: true,
        model: "x",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: { role: "assistant", content: [{ type: "text", text: "Hi back" }] },
      },
    })
    const digest = computeLineageDigest(entry)
    expect(digest!.postResponseHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("computeLineageDigest — tool_use_id extraction", () => {
  test("producedToolUseIds collects every tool_use.id in the assistant response", () => {
    const entry = makeEntry({
      inboundRequest: { model: "x", messages: [{ role: "user", content: "do stuff" }] },
      outboundResponse: {
        success: true,
        model: "x",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll do two things" },
            { type: "tool_use", id: "toolu_A", name: "Read", input: { path: "/a" } },
            { type: "tool_use", id: "toolu_B", name: "Read", input: { path: "/b" } },
          ],
        },
      },
    })
    const digest = computeLineageDigest(entry)
    expect(digest!.producedToolUseIds).toEqual(["toolu_A", "toolu_B"])
  })

  test("producedToolUseIds skips server_tool_use (different block type)", () => {
    const entry = makeEntry({
      inboundRequest: { model: "x", messages: [{ role: "user", content: "search" }] },
      outboundResponse: {
        success: true,
        model: "x",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_X", name: "web_search", input: { query: "q" } },
            { type: "tool_use", id: "toolu_real", name: "Read", input: {} },
          ],
        },
      },
    })
    const digest = computeLineageDigest(entry)
    expect(digest!.producedToolUseIds).toEqual(["toolu_real"])
  })

  test("backToolUseId pulls first tool_result in last message", () => {
    const messages: Array<MessageContent> = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_X", content: "output" },
          { type: "text", text: "and please continue" },
        ],
      },
    ]
    const entry = makeEntry({ inboundRequest: { model: "x", messages } })
    const digest = computeLineageDigest(entry)
    expect(digest!.backToolUseId).toBe("toolu_X")
  })

  test("backToolUseId is null when last message is pure-text user (~1% case)", () => {
    const messages: Array<MessageContent> = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "follow-up question" },
    ]
    const entry = makeEntry({ inboundRequest: { model: "x", messages } })
    const digest = computeLineageDigest(entry)
    expect(digest!.backToolUseId).toBeNull()
  })

  test("backToolUseId is null on first turn (only one message, no parent possible)", () => {
    const entry = makeEntry({
      inboundRequest: { model: "x", messages: [{ role: "user", content: "first turn" }] },
    })
    const digest = computeLineageDigest(entry)
    expect(digest!.backToolUseId).toBeNull()
  })
})

describe("computeLineageDigest — parent→child verification (the core algorithm property)", () => {
  test("child.turnHashes[parent.turnHashes.length] === parent.postResponseHash", () => {
    // Parent: 1 user msg, completed with 1 assistant response.
    const parentMessages: Array<MessageContent> = [{ role: "user", content: "Q1" }]
    const assistantContent: MessageContent["content"] = [{ type: "tool_use", id: "toolu_PARENT", name: "Read", input: { path: "/x" } }]
    const parent = makeEntry({
      id: "req_parent",
      inboundRequest: { model: "x", messages: parentMessages },
      outboundResponse: {
        success: true,
        model: "x",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: { role: "assistant", content: assistantContent },
      },
    })
    const parentDigest = computeLineageDigest(parent)
    expect(parentDigest!.postResponseHash).not.toBeNull()
    expect(parentDigest!.producedToolUseIds).toEqual(["toolu_PARENT"])

    // Child: echoes parent's response + adds a new tool_result.
    const childMessages: Array<MessageContent> = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: assistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_PARENT", content: "file contents" }] },
    ]
    const child = makeEntry({
      id: "req_child",
      inboundRequest: { model: "x", messages: childMessages },
    })
    const childDigest = computeLineageDigest(child)

    // Primary edge: backToolUseId points at parent's tool_use id.
    expect(childDigest!.backToolUseId).toBe("toolu_PARENT")

    // Verifier: at the position where parent's response would land
    // (== parent.turnHashes.length == 1), the child's turn hash equals
    // parent's postResponseHash.
    const offset = parentDigest!.turnHashes.length
    const parentPost = parentDigest!.postResponseHash
    expect(parentPost).not.toBeNull()
    expect(childDigest!.turnHashes[offset]).toBe(parentPost as string)
  })

  test("rootHash collides for two entries from same conversation root (canonicalization works)", () => {
    // Two entries from the same conversation: same system, same tools, same msg[0]
    // (different cache_control on msg[0]) should produce the same rootHash.
    const msg0WithCC: MessageContent = {
      role: "user",

      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] as any,
    }
    const msg0WithoutCC: MessageContent = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    }
    const a = makeEntry({
      id: "a",
      inboundRequest: { model: "x", system: "SYS", messages: [msg0WithCC] },
    })
    const b = makeEntry({
      id: "b",
      inboundRequest: { model: "x", system: "SYS", messages: [msg0WithoutCC] },
    })
    expect(computeLineageDigest(a)!.rootHash).toBe(computeLineageDigest(b)!.rootHash)
  })

  test("different system → different rootHash (msg[0] alone would collide)", () => {
    const msg0: MessageContent = { role: "user", content: "/init" }
    const a = makeEntry({
      id: "a",
      inboundRequest: { model: "x", system: "agent-A", messages: [msg0] },
    })
    const b = makeEntry({
      id: "b",
      inboundRequest: { model: "x", system: "agent-B", messages: [msg0] },
    })
    expect(computeLineageDigest(a)!.rootHash).not.toBe(computeLineageDigest(b)!.rootHash)
  })
})

describe("computeLineageDigest — robustness", () => {
  test("does not throw on malformed content (string content where array expected)", () => {
    const entry = makeEntry({
      inboundRequest: { model: "x", messages: [{ role: "user", content: "string form" }] },
    })
    expect(() => computeLineageDigest(entry)).not.toThrow()
  })

  test("does not mutate entry.inboundRequest.messages", () => {
    const messages: Array<MessageContent> = [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] as any }]
    const before = JSON.stringify(messages)
    const entry = makeEntry({ inboundRequest: { model: "x", messages } })
    computeLineageDigest(entry)
    expect(JSON.stringify(messages)).toBe(before)
  })
})
