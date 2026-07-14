import {
  //
  afterEach,
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
import { filterEmptyThinkingBlocks } from "~/lib/anthropic/sanitize/content-blocks"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

afterEach(autoRestoreState)

/** Build an assistant message with the given content blocks. */
function assistant(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "assistant", content } as unknown as MessageParam
}

describe("filterEmptyThinkingBlocks (pure)", () => {
  describe("all_empty (conservative: only double-empty)", () => {
    test("removes a double-empty thinking block (text AND signature empty)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "hello" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "all_empty")
      expect((out.content as Array<unknown>).length).toBe(1)
      expect((out.content as Array<{ type: string }>)[0].type).toBe("text")
    })

    test("KEEPS a legitimate encrypted thinking block (empty text + valid signature)", () => {
      // This is the normal upstream shape for encrypted thinking — must NOT be deleted.
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "EoAQCmMIDhgC...validsig" },
        { type: "text", text: "answer" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "all_empty")
      expect(out).toBe(msg) // unchanged reference — nothing filtered
    })

    test("keeps a plaintext thinking block (non-empty text + signature)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "real reasoning", signature: "sig123" },
        { type: "text", text: "hello" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "all_empty")
      expect(out).toBe(msg)
    })

    test("keeps an unsigned-but-texted thinking block (text non-empty, sig empty) — only sig-based/any modes drop it", () => {
      const msg = assistant([
        { type: "thinking", thinking: "reasoning", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "all_empty")
      expect(out).toBe(msg)
    })
  })

  describe("signature_empty (aggressive: any unsigned thinking block)", () => {
    test("removes a double-empty block", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "signature_empty")
      expect((out.content as Array<unknown>).length).toBe(1)
    })

    test("removes an unsigned thinking block even when text is non-empty", () => {
      const msg = assistant([
        { type: "thinking", thinking: "reasoning", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "signature_empty")
      const blocks = out.content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    })

    test("KEEPS a legitimate encrypted thinking block (empty text + valid signature)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "validsig" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "signature_empty")
      expect(out).toBe(msg)
    })
  })

  describe("thinking_empty (aggressive: any empty-text thinking block, incl. legit encrypted)", () => {
    test("removes a legitimate encrypted thinking block (empty text + valid signature)", () => {
      // AGGRESSIVE mode: text-empty triggers the drop even with a valid signature.
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "validsig" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "thinking_empty")
      const blocks = out.content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    })

    test("removes a double-empty block", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "thinking_empty")
      expect((out.content as Array<unknown>).length).toBe(1)
    })

    test("KEEPS an unsigned-but-texted thinking block (text non-empty, sig empty)", () => {
      // text is non-empty, so thinking_empty (text-based) does not drop it.
      const msg = assistant([
        { type: "thinking", thinking: "reasoning", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "thinking_empty")
      expect(out).toBe(msg)
    })

    test("keeps a fully-populated thinking block (non-empty text + signature)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "real reasoning", signature: "sig123" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "thinking_empty")
      expect(out).toBe(msg)
    })
  })

  describe("any_empty (most aggressive: either field empty)", () => {
    test("removes a double-empty block", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "any_empty")
      expect((out.content as Array<unknown>).length).toBe(1)
    })

    test("removes a legitimate encrypted thinking block (empty text + valid signature)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "validsig" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "any_empty")
      const blocks = out.content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    })

    test("removes an unsigned-but-texted thinking block (text non-empty, sig empty)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "reasoning", signature: "" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "any_empty")
      const blocks = out.content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    })

    test("keeps a fully-populated thinking block (non-empty text + signature)", () => {
      const msg = assistant([
        { type: "thinking", thinking: "real reasoning", signature: "sig123" },
        { type: "text", text: "x" },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "any_empty")
      expect(out).toBe(msg)
    })
  })

  describe("shared invariants", () => {
    test("in a mixed message, drops only corrupt block and keeps valid encrypted one", () => {
      const msg = assistant([
        { type: "thinking", thinking: "", signature: "" }, // corrupt double-empty
        { type: "thinking", thinking: "", signature: "validsig" }, // legit encrypted
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ])
      const [out] = filterEmptyThinkingBlocks([msg], "all_empty")
      const blocks = out.content as Array<{ type: string; signature?: string }>
      expect(blocks.length).toBe(2)
      expect(blocks.find((b) => b.type === "thinking")?.signature).toBe("validsig")
      expect(blocks.some((b) => b.type === "tool_use")).toBe(true)
    })

    test("leaves redacted_thinking (carries data, not signature) untouched in all modes", () => {
      const msg = assistant([
        { type: "redacted_thinking", data: "encrypted" },
        { type: "text", text: "x" },
      ])
      expect(filterEmptyThinkingBlocks([msg], "all_empty")[0]).toBe(msg)
      expect(filterEmptyThinkingBlocks([msg], "signature_empty")[0]).toBe(msg)
      expect(filterEmptyThinkingBlocks([msg], "thinking_empty")[0]).toBe(msg)
      expect(filterEmptyThinkingBlocks([msg], "any_empty")[0]).toBe(msg)
    })

    test("string content is passed through unchanged", () => {
      const msg = { role: "user", content: "plain" } as MessageParam
      expect(filterEmptyThinkingBlocks([msg], "all_empty")[0]).toBe(msg)
    })
  })
})

describe("sanitizeAnthropicMessages thinking_block_sanitize gating", () => {
  function payloadWithBlocks(blocks: Array<Record<string, unknown>>): MessagesPayload {
    return {
      model: "claude-opus-4.8",
      messages: [{ role: "user", content: "hi" }, assistant(blocks), { role: "user", content: "next" }],
      max_tokens: 100,
    } as unknown as MessagesPayload
  }

  test("all_empty: double-empty block removed before upstream", () => {
    setStateForTests({ thinkingBlockSanitizeCheck: "all_empty" })
    const { payload } = sanitizeAnthropicMessages(
      payloadWithBlocks([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "answer" },
      ]),
    )
    const blocks = payload.messages[1].content as Array<{ type: string }>
    expect(blocks.some((b) => b.type === "thinking")).toBe(false)
    expect(blocks.some((b) => b.type === "text")).toBe(true)
  })

  test("all_empty: legitimate encrypted thinking (empty text + signature) is KEPT", () => {
    setStateForTests({ thinkingBlockSanitizeCheck: "all_empty" })
    const { payload } = sanitizeAnthropicMessages(
      payloadWithBlocks([
        { type: "thinking", thinking: "", signature: "validsig" },
        { type: "text", text: "answer" },
      ]),
    )
    const blocks = payload.messages[1].content as Array<{ type: string; signature?: string }>
    expect(blocks.find((b) => b.type === "thinking")?.signature).toBe("validsig")
  })

  test("false: corrupt block passes through unchanged", () => {
    setStateForTests({ thinkingBlockSanitizeCheck: false })
    const { payload } = sanitizeAnthropicMessages(
      payloadWithBlocks([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "answer" },
      ]),
    )
    const blocks = payload.messages[1].content as Array<{ type: string; thinking?: string }>
    expect(blocks.find((b) => b.type === "thinking")?.thinking).toBe("")
  })
})

describe("sanitizeAnthropicMessages — synthetic-reasoning sentinel strip (echo-back poison guard)", () => {
  const SENTINEL = "copilot-api:synthetic-reasoning:v1"
  function payloadWithBlocks(blocks: Array<Record<string, unknown>>): MessagesPayload {
    return {
      model: "claude-opus-4.8",
      messages: [{ role: "user", content: "hi" }, assistant(blocks), { role: "user", content: "next" }],
      max_tokens: 100,
    } as unknown as MessagesPayload
  }

  test("sentinel-signed thinking block is stripped even when thinkingBlockSanitizeCheck is OFF (unconditional)", () => {
    // The strongest gate: config OFF means the empty-thinking filter is disabled — a real corrupt block
    // would pass through (see the test above). Our sentinel block (non-empty text + non-empty sentinel
    // signature) MUST still be removed, proving the strip is unconditional, not config-gated.
    setStateForTests({ thinkingBlockSanitizeCheck: false })
    const { payload } = sanitizeAnthropicMessages(
      payloadWithBlocks([
        { type: "thinking", thinking: "forwarded gpt reasoning", signature: SENTINEL },
        { type: "text", text: "answer" },
      ]),
    )
    const blocks = payload.messages[1].content as Array<{ type: string }>
    expect(blocks.some((b) => b.type === "thinking"), "sentinel thinking must be stripped").toBe(false)
    expect(blocks.some((b) => b.type === "text"), "real text must survive").toBe(true)
  })

  test("a REAL signed thinking block (non-sentinel signature) is NOT stripped by the sentinel guard", () => {
    // The sentinel strip must be surgical: a legitimate encrypted thinking block (real signature) is kept.
    setStateForTests({ thinkingBlockSanitizeCheck: false })
    const { payload } = sanitizeAnthropicMessages(
      payloadWithBlocks([
        { type: "thinking", thinking: "", signature: "real-upstream-signature" },
        { type: "text", text: "answer" },
      ]),
    )
    const blocks = payload.messages[1].content as Array<{ type: string; signature?: string }>
    expect(blocks.find((b) => b.type === "thinking")?.signature).toBe("real-upstream-signature")
  })
})
