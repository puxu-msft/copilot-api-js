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

import { clearAnthropicFeatureNegotiationForTests } from "~/lib/anthropic/feature-negotiation"
import { sanitizeInlineSystemMessages } from "~/lib/anthropic/sanitize/system-messages"
import {
  //
  setAnthropicBehavior,
  setStateForTests,
} from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

// Cast helper: the Anthropic SDK's MessageParam.role includes "system", but our
// narrowed builders don't — inline system is exactly the illegal shape we handle.
function sys(content: MessageParam["content"]): MessageParam {
  return { role: "system", content } as MessageParam
}

describe("sanitizeInlineSystemMessages", () => {
  autoRestoreState()

  const base: Array<MessageParam> = [
    { role: "user", content: "hi" },
    sys("INLINE SYSTEM"),
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
  ]

  describe("false / no-op", () => {
    test("mode=false returns the same array reference (identity)", () => {
      const result = sanitizeInlineSystemMessages(base, "top", false)
      expect(result.messages).toBe(base)
      expect(result.system).toBe("top")
      expect(result.convertedCount).toBe(0)
    })

    test.each(["drop_invalid", "merge", "as_user", "as_assistant"] as const)("mode=%s is no-op when no inline system present", (mode) => {
      const clean: Array<MessageParam> = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ]
      const result = sanitizeInlineSystemMessages(clean, "top", mode)
      expect(result.messages).toBe(clean)
      expect(result.convertedCount).toBe(0)
    })
  })

  describe("drop_invalid", () => {
    test("removes every inline system message", () => {
      const result = sanitizeInlineSystemMessages(base, "top", "drop_invalid")
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      expect(result.convertedCount).toBe(1)
      expect(result.system).toBe("top")
    })
  })

  describe("merge", () => {
    test("appends inline system text to a string top-level system", () => {
      const result = sanitizeInlineSystemMessages(base, "top", "merge")
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      expect(result.system).toBe("top\n\nINLINE SYSTEM")
      expect(result.convertedCount).toBe(1)
    })

    test("appends a text block when top-level system is an array", () => {
      const result = sanitizeInlineSystemMessages(base, [{ type: "text", text: "top" }], "merge")
      expect(result.system).toEqual([
        { type: "text", text: "top" },
        { type: "text", text: "INLINE SYSTEM" },
      ])
    })

    test("sets system from extracted text when top-level system is undefined", () => {
      const result = sanitizeInlineSystemMessages(base, undefined, "merge")
      expect(result.system).toBe("INLINE SYSTEM")
    })

    test("concatenates multiple inline system messages in order", () => {
      const msgs: Array<MessageParam> = [{ role: "user", content: "a" }, sys("S1"), { role: "assistant", content: "b" }, sys("S2")]
      const result = sanitizeInlineSystemMessages(msgs, "top", "merge")
      expect(result.system).toBe("top\n\nS1\n\nS2")
      expect(result.convertedCount).toBe(2)
    })

    test("extracts text from array content, warning-dropping non-text blocks", () => {
      const msgs: Array<MessageParam> = [
        { role: "user", content: "a" },
        sys([{ type: "text", text: "keep me" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } } as never]),
      ]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "merge")
      expect(result.system).toBe("keep me")
    })

    test("drops an empty-extraction inline system without appending", () => {
      const msgs: Array<MessageParam> = [{ role: "user", content: "a" }, sys("   ")]
      const result = sanitizeInlineSystemMessages(msgs, "top", "merge")
      expect(result.system).toBe("top")
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      expect(result.convertedCount).toBe(1)
    })
  })

  describe("as_user", () => {
    test("rewrites role to user and merges with adjacent user", () => {
      const msgs: Array<MessageParam> = [{ role: "user", content: "first" }, sys("ctx"), { role: "assistant", content: "reply" }]
      const result = sanitizeInlineSystemMessages(msgs, "top", "as_user")
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      // user "first" + converted "ctx" merge into one user turn
      expect(result.messages[0].role).toBe("user")
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
      const firstContent = result.messages[0].content
      expect(Array.isArray(firstContent)).toBe(true)
      expect(result.convertedCount).toBe(1)
    })

    test("preserves an image-only system message as a user message (not empty)", () => {
      const msgs: Array<MessageParam> = [
        { role: "assistant", content: "x" },
        sys([{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } } as never]),
      ]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_user")
      expect(result.messages.map((m) => m.role)).toEqual(["assistant", "user"])
      expect(result.convertedCount).toBe(1)
    })

    test("drops empty-content inline system instead of emitting empty user", () => {
      const msgs: Array<MessageParam> = [{ role: "assistant", content: "x" }, sys("  ")]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_user")
      expect(result.messages.map((m) => m.role)).toEqual(["assistant"])
      expect(result.convertedCount).toBe(1)
    })

    test("preserves tool_use→tool_result resolvability when system sits between them", () => {
      const msgs: Array<MessageParam> = [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        sys("ctx"),
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_user")
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      // The converted user (ctx) and the tool_result user are adjacent → merged into
      // one user turn that still carries tool_result t1 right after the tool_use turn.
      const toolUseIdx = result.messages.findIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"))
      const next = result.messages[toolUseIdx + 1]
      expect(next.role).toBe("user")
      const hasToolResult = Array.isArray(next.content) && next.content.some((b) => b.type === "tool_result" && b.tool_use_id === "t1")
      expect(hasToolResult).toBe(true)
    })
  })

  describe("as_assistant", () => {
    test("rewrites role to assistant and merges with adjacent assistant", () => {
      const msgs: Array<MessageParam> = [{ role: "user", content: "u" }, { role: "assistant", content: "prev" }, sys("ctx")]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_assistant")
      expect(result.messages.some((m) => m.role === "system")).toBe(false)
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    })

    test("drops a leading system (would make messages[0] an illegal assistant) — content is intentionally lost", () => {
      const msgs: Array<MessageParam> = [sys("leading ctx"), { role: "user", content: "u" }]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_assistant")
      expect(result.messages.map((m) => m.role)).toEqual(["user"])
      // Documented as_assistant side-effect: a leading system→assistant would be an
      // illegal messages[0], so ensureAnthropicStartsWithUser drops it entirely —
      // its content does NOT survive anywhere. This is why as_assistant is flagged
      // experimental/not-recommended.
      const serialized = JSON.stringify(result.messages)
      expect(serialized).not.toContain("leading ctx")
      // Still counted as handled (dropping is a form of handling).
      expect(result.convertedCount).toBe(1)
    })

    test("never merges into a signed-thinking assistant (identity preserved)", () => {
      setStateForTests({ thinkingBlockMessagePolicy: "preserve" })
      const signed: MessageParam = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret", signature: "sig123" } as never, { type: "text", text: "answer" }],
      }
      const msgs: Array<MessageParam> = [{ role: "user", content: "u" }, signed, sys("ctx")]
      const result = sanitizeInlineSystemMessages(msgs, undefined, "as_assistant")
      // signed assistant kept byte-identical; ctx becomes a separate assistant turn
      const keptSigned = result.messages.find((m) => m === signed)
      expect(keptSigned).toBe(signed)
      expect(result.messages.filter((m) => m.role === "assistant").length).toBe(2)
    })
  })

  describe("idempotency", () => {
    test.each(["drop_invalid", "merge", "as_user", "as_assistant"] as const)("mode=%s second pass is a no-op", (mode) => {
      const first = sanitizeInlineSystemMessages(base, "top", mode)
      const second = sanitizeInlineSystemMessages(first.messages, first.system, mode)
      expect(second.messages).toBe(first.messages)
      expect(second.convertedCount).toBe(0)
      expect(second.system).toBe(first.system)
    })
  })
})

// End-to-end through the full sanitizer to confirm the integration point.
describe("sanitizeAnthropicMessages × system_messages_sanitize", () => {
  autoRestoreState()

  test("merge folds inline system into top-level system on the real pipeline", async () => {
    const { sanitizeAnthropicMessages } = await import("~/lib/anthropic/sanitize")
    setStateForTests({ systemMessagesSanitize: "merge" })
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      system: "top",
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "INLINE" } as MessageParam, { role: "assistant", content: "yo" }],
    }
    const result = sanitizeAnthropicMessages(payload)
    expect(result.payload.messages.some((m) => m.role === "system")).toBe(false)
    expect(result.payload.system).toContain("INLINE")
    expect(result.stats.inlineSystemConverted).toBe(1)
  })

  test("false leaves inline system untouched (current default behavior)", async () => {
    const { sanitizeAnthropicMessages } = await import("~/lib/anthropic/sanitize")
    setStateForTests({ systemMessagesSanitize: false })
    const payload: MessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "INLINE" } as MessageParam],
    }
    const result = sanitizeAnthropicMessages(payload)
    expect(result.payload.messages.some((m) => m.role === "system")).toBe(true)
    expect(result.stats.inlineSystemConverted).toBe(0)
  })
})

// PROACTIVE side (feature A): the per-model effective sanitize mode. Even with the
// global `system_messages_sanitize` OFF (false), a model in the reject set is
// sanitized via `system_reject_mode`; a non-reject model is left untouched.
describe("sanitizeAnthropicMessages × per-model reject set (proactive)", () => {
  autoRestoreState()
  afterEach(() => clearAnthropicFeatureNegotiationForTests())

  test("reject-set model is sanitized despite global false", async () => {
    const { sanitizeAnthropicMessages } = await import("~/lib/anthropic/sanitize")
    setAnthropicBehavior({ systemMessagesSanitize: false, systemRejectModels: ["claude-sonnet-4.6"], systemRejectMode: "as_user" })
    const payload: MessagesPayload = {
      model: "claude-sonnet-4.6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "INLINE" } as MessageParam, { role: "assistant", content: "yo" }],
    }
    const result = sanitizeAnthropicMessages(payload)
    expect(result.payload.messages.some((m) => m.role === "system")).toBe(false)
    expect(result.stats.inlineSystemConverted).toBe(1)
  })

  test("non-reject model is left untouched under global false (passthrough)", async () => {
    const { sanitizeAnthropicMessages } = await import("~/lib/anthropic/sanitize")
    setAnthropicBehavior({ systemMessagesSanitize: false, systemRejectModels: ["claude-sonnet-4.6"], systemRejectMode: "as_user" })
    const payload: MessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "INLINE" } as MessageParam],
    }
    const result = sanitizeAnthropicMessages(payload)
    expect(result.payload.messages.some((m) => m.role === "system")).toBe(true)
    expect(result.stats.inlineSystemConverted).toBe(0)
  })
})
