import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageContent } from "~/lib/history/types"

import {
  //
  MSG_HASH_BYTES,
  hashMessage,
  normalizeMessageForIndex,
} from "~/lib/history/normalize-message"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

describe("hashMessage width", () => {
  test("is MSG_HASH_BYTES bytes → 32 hex chars", () => {
    const hash = hashMessage({ role: "user", content: "x" }, "anthropic")
    expect(MSG_HASH_BYTES).toBe(16)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("determinism and stable key order", () => {
  test("same message → same normalized string and hash", () => {
    const msg: MessageContent = { role: "user", content: "hello" }
    expect(normalizeMessageForIndex(msg, "anthropic")).toBe(normalizeMessageForIndex(msg, "anthropic"))
    expect(hashMessage(msg, "anthropic")).toBe(hashMessage(msg, "anthropic"))
  })

  test("object key insertion order does not change the hash", () => {
    const a = { role: "user", content: [{ type: "text", text: "hi" }] }
    // Same content blocks, keys inserted in a different order.
    const b = { content: [{ text: "hi", type: "text" }], role: "user" }
    expect(hashMessage(a as MessageContent, "anthropic")).toBe(hashMessage(b as MessageContent, "anthropic"))
  })

  test("content:undefined and content:null hash identically", () => {
    const withUndefined = { role: "assistant" } as unknown as MessageContent
    const withNull: MessageContent = { role: "assistant", content: null }
    expect(hashMessage(withUndefined, "openai")).toBe(hashMessage(withNull, "openai"))
  })
})

describe("cache_control is stripped recursively → cross-turn dedup", () => {
  // Golden pair captured from two consecutive live Claude Code requests
  // (req_306 msg[19] and req_307 msg[19], same session). Claude Code moved the
  // ephemeral cache_control breakpoint off this tool_result between turns; the
  // messages are otherwise byte-identical. Both must normalize/hash equal, else
  // the message re-hashes every turn and dedup degenerates (RFC empirical point).
  const withCacheControl: MessageContent = {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01Y73sXxB6Uvr9FVvnQCorTH",
        type: "tool_result",
        content:
          "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
        cache_control: { type: "ephemeral" },
      },
    ],
  }
  const withoutCacheControl: MessageContent = {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01Y73sXxB6Uvr9FVvnQCorTH",
        type: "tool_result",
        content:
          "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
      },
    ],
  }

  test("the live golden pair hashes equal", () => {
    expect(hashMessage(withCacheControl, "anthropic")).toBe(hashMessage(withoutCacheControl, "anthropic"))
  })

  test("normalized text contains no cache_control / ephemeral marker", () => {
    const normalized = normalizeMessageForIndex(withCacheControl, "anthropic")
    expect(normalized).not.toContain("cache_control")
    expect(normalized).not.toContain("ephemeral")
  })

  test("nested cache_control at message level is also stripped", () => {
    const messageLevel = { role: "user", content: "hi", cache_control: { type: "ephemeral" } } as unknown as MessageContent
    const plain: MessageContent = { role: "user", content: "hi" }
    expect(hashMessage(messageLevel, "anthropic")).toBe(hashMessage(plain, "anthropic"))
  })
})

describe("injected boilerplate is stripped from prose text", () => {
  test("own-line <system-reminder> block is removed from string content", () => {
    const withReminder: MessageContent = {
      role: "user",
      content: "What is 2+2?\n<system-reminder>\nThe user opened a file.\n</system-reminder>",
    }
    const normalized = normalizeMessageForIndex(withReminder, "anthropic")
    expect(normalized).toContain("What is 2+2?")
    expect(normalized).not.toContain("system-reminder")
    expect(normalized).not.toContain("The user opened a file")
  })

  test("own-line ide_* blocks are removed", () => {
    const withIde: MessageContent = {
      role: "user",
      content: "do the thing\n<ide_opened_file>/a/b.ts</ide_opened_file>\n<ide_diagnostics>\nerror: x\n</ide_diagnostics>",
    }
    const normalized = normalizeMessageForIndex(withIde, "anthropic")
    expect(normalized).toContain("do the thing")
    expect(normalized).not.toContain("ide_opened_file")
    expect(normalized).not.toContain("ide_diagnostics")
  })

  test("CRLF-encoded own-line blocks strip identically to LF (Windows transcripts)", () => {
    const crlf: MessageContent = { role: "user", content: "A\r\n<system-reminder>\r\nx\r\n</system-reminder>\r\nB" }
    const lf: MessageContent = { role: "user", content: "A\n<system-reminder>\nx\n</system-reminder>\nB" }
    const normalized = normalizeMessageForIndex(crlf, "anthropic")
    expect(normalized).not.toContain("system-reminder")
    expect(normalized).toContain("A")
    expect(normalized).toContain("B")
    // The volatile block is gone in both carriers — a CRLF block must not survive
    // into the hash (else it re-hashes the message every turn).
    expect(normalizeMessageForIndex(lf, "anthropic")).not.toContain("system-reminder")
  })

  test("INLINE literal tag mentions (real searchable content) are NOT stripped", () => {
    // Real transcripts discuss these tag names in prose/docs; only structurally
    // injected own-line blocks should be removed, never inline mentions.
    const withMention: MessageContent = {
      role: "assistant",
      content: "We filter out `<system-reminder>` and `<ide_opened_file>` tags from previews.",
    }
    const normalized = normalizeMessageForIndex(withMention, "anthropic")
    expect(normalized).toContain("system-reminder")
    expect(normalized).toContain("ide_opened_file")
  })

  test("reminder stripping reaches Anthropic text blocks and tool_result content", () => {
    const msg: MessageContent = {
      role: "user",
      content: [
        { type: "text", text: "question\n<system-reminder>\nnoise\n</system-reminder>" },
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file output\n<system-reminder>\nide noise\n</system-reminder>",
        },
      ],
    }
    const normalized = normalizeMessageForIndex(msg, "anthropic")
    expect(normalized).toContain("question")
    expect(normalized).toContain("file output")
    expect(normalized).not.toContain("system-reminder")
    expect(normalized).not.toContain("ide noise")
  })

  test("reminder stripping recurses into ARRAY-form tool_result content blocks", () => {
    // tool_result.content can itself be an array of text blocks — the prompt
    // flags this nested location as a key per-turn-volatile carrier.
    const msg: MessageContent = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "real output\n<system-reminder>\nnested noise\n</system-reminder>" }],
        },
      ],
    }
    const normalized = normalizeMessageForIndex(msg, "anthropic")
    expect(normalized).toContain("real output")
    expect(normalized).not.toContain("system-reminder")
    expect(normalized).not.toContain("nested noise")
  })
  test("non-text blocks (tool_use / thinking / image) pass through unchanged", () => {
    const msg: MessageContent = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "Search", input: { q: "x" } },
      ],
    }
    const normalized = normalizeMessageForIndex(msg, "anthropic")
    expect(normalized).toContain("reasoning")
    expect(normalized).toContain("Search")
    expect(normalized).toContain("sig")
  })
})

describe("format shapes — Anthropic vs OpenAI/Gemini", () => {
  test("OpenAI loose array parts have boilerplate stripped via .text", () => {
    const msg: MessageContent = {
      role: "user",
      content: [{ type: "text", text: "hi\n<system-reminder>\nx\n</system-reminder>" }] as Array<unknown>,
    }
    expect(normalizeMessageForIndex(msg, "openai")).not.toContain("system-reminder")
  })

  test("OpenAI role:tool message normalizes deterministically", () => {
    const msg: MessageContent = { role: "tool", content: "result", tool_call_id: "call_1", name: "search" }
    expect(normalizeMessageForIndex(msg, "openai")).toBe(normalizeMessageForIndex(msg, "openai"))
    expect(hashMessage(msg, "openai")).toMatch(/^[0-9a-f]{32}$/)
  })

  test("OpenAI assistant tool_calls are preserved (data, not stripped as prose)", () => {
    const msg: MessageContent = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
    }
    const normalized = normalizeMessageForIndex(msg, "openai")
    expect(normalized).toContain("search")
    expect(normalized).toContain("call_1")
  })

  test("Gemini parts route through the loose array path", () => {
    const msg: MessageContent = { role: "user", content: [{ text: "ask\n<ide_selection>\nsel\n</ide_selection>" }] as Array<unknown> }
    expect(normalizeMessageForIndex(msg, "gemini")).not.toContain("ide_selection")
  })
})

describe("config-independence (does NOT read state.rewriteSystemReminders)", () => {
  autoRestoreState()

  test("flipping rewriteSystemReminders does not change the hash", () => {
    const msg: MessageContent = {
      role: "user",
      content: "ask\n<system-reminder>\nctx\n</system-reminder>",
    }
    setStateForTests({ rewriteSystemReminders: false })
    const off = hashMessage(msg, "anthropic")
    setStateForTests({ rewriteSystemReminders: true })
    const on = hashMessage(msg, "anthropic")
    expect(on).toBe(off)
  })
})
