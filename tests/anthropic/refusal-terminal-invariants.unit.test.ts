/**
 * Terminal-completeness + real-sample regression tests for the contentless-refusal rewriter.
 *
 * These lock the invariants the third review round found, using the THREE real upstream samples
 * recovered in exp/refusal-samples/FINDINGS.md as read-only fixtures (expected values hand-written):
 *
 *   req_1782214935133_68   category:null   1 thinking block   no output_tokens_details
 *   req_1783947618475_731  category:"bio"  1 thinking block   thinking_tokens 25636 / output 25848
 *   req_1785187727725_842  category:"cyber"  ZERO blocks      thinking_tokens 0 / output 1
 *
 * The load-bearing invariant is EXACTLY ONE COMPLETE CLIENT TERMINUS: suppression must not merely
 * avoid a second terminal, it must emit a terminus the client SDK can finalize. A synthesized
 * `end_turn` delta with no `message_stop` makes @anthropic-ai/sdk throw
 * "stream ended without producing a Message with role=assistant" — the exact turn interruption that
 * suppression exists to prevent.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RefusalPolicy } from "~/lib/anthropic/refusal-policy"
import type { StreamEvent } from "~/types/api/anthropic"

import { createRefusalRewriter } from "~/lib/anthropic/recover-refusal"

const STATIC = { model: "claude-opus-5", request_id: "req_1" }

function policy(mode: RefusalPolicy["mode"], endTurnText = "blocked c={refusal_category}"): RefusalPolicy {
  return { mode, endTurnText, errorMessage: "err c={refusal_category}", errorType: "api_error" }
}

function drive(events: Array<Record<string, unknown>>, p: RefusalPolicy): Array<ServerSentEventMessage> {
  const rewriter = createRefusalRewriter({ policy: p, staticVars: STATIC })
  const out: Array<ServerSentEventMessage> = []
  for (const ev of events) out.push(...rewriter.processEvent(ev as unknown as StreamEvent, { data: JSON.stringify(ev) }))
  return out
}

/** Frame types the client actually receives, in order. */
function types(frames: Array<ServerSentEventMessage>): Array<string> {
  return frames.map((f) => (JSON.parse(f.data ?? "{}") as { type?: string }).type ?? f.event ?? "?")
}

// ─── the three real upstream stop_details, verbatim ───
const NULL_CATEGORY = {
  type: "refusal",
  category: null,
  explanation: "API integrators: you can reduce refusals for your users by configuring a fallback model",
}
const BIO_CATEGORY = {
  type: "refusal",
  category: "bio",
  explanation: "API integrators: you can reduce refusals for your users by configuring a fallback model",
}
const CYBER_CATEGORY = { type: "refusal", category: "cyber", explanation: "This request triggered restrictions on violative cyber content" }

const messageStart = { type: "message_start", message: { content: [], role: "assistant" } }
const thinkingStart = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }
const thinkingStop = { type: "content_block_stop", index: 0 }

function refusalDelta(stopDetails: unknown, usage: Record<string, unknown>): Record<string, unknown> {
  return { type: "message_delta", delta: { stop_reason: "refusal", stop_details: stopDetails, stop_sequence: null }, usage }
}

describe("exactly one COMPLETE terminus", () => {
  test("suppression emits its own message_stop when the upstream never sends one", () => {
    // The cyber sample's shape: zero content blocks, refusal delta, then the stream just ends.
    const out = drive([messageStart, refusalDelta(CYBER_CATEGORY, { output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } })], policy("end_turn"))
    expect(types(out)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    const delta = JSON.parse(out[4].data ?? "") as { delta: { stop_reason: string } }
    expect(delta.delta.stop_reason).toBe("end_turn")
  })

  test("the upstream's own message_stop is suppressed as a duplicate (never two terminators)", () => {
    const out = drive(
      [messageStart, thinkingStart, thinkingStop, refusalDelta(NULL_CATEGORY, { output_tokens: 1097 }), { type: "message_stop" }],
      policy("end_turn"),
    )
    expect(types(out).filter((t) => t === "message_stop")).toHaveLength(1)
    expect(types(out).filter((t) => t === "message_delta")).toHaveLength(1)
  })

  test("a repeated refusal delta does not synthesize a second block or terminator", () => {
    const d = refusalDelta(BIO_CATEGORY, { output_tokens: 25848, output_tokens_details: { thinking_tokens: 25636 } })
    const out = drive([messageStart, thinkingStart, thinkingStop, d, d, { type: "message_stop" }], policy("end_turn"))
    expect(types(out).filter((t) => t === "message_stop")).toHaveLength(1)
    expect(types(out).filter((t) => t === "content_block_start")).toHaveLength(2) // the thinking block + ONE synthetic text
  })

  test("content frames arriving after the terminus are suppressed", () => {
    const out = drive(
      [
        messageStart,
        refusalDelta(CYBER_CATEGORY, { output_tokens: 1 }),
        { type: "content_block_start", index: 5, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "late" } },
      ],
      policy("end_turn"),
    )
    expect(out.some((f) => (f.data ?? "").includes("late"))).toBe(false)
  })

  test("error mode emits the error frame and no message_stop after it", () => {
    const out = drive([messageStart, refusalDelta(CYBER_CATEGORY, { output_tokens: 1 }), { type: "message_stop" }], policy("error"))
    expect(out.filter((f) => f.event === "error")).toHaveLength(1)
    expect(types(out).filter((t) => t === "message_stop")).toHaveLength(0)
  })
})

describe("passthrough stays byte-identical (positive control for the suppression tests above)", () => {
  test("refusal mode forwards every frame unchanged, including the refusal delta", () => {
    const events = [messageStart, thinkingStart, thinkingStop, refusalDelta(BIO_CATEGORY, { output_tokens: 25848 }), { type: "message_stop" }]
    const out = drive(events, policy("refusal"))
    expect(out.map((f) => f.data)).toEqual(events.map((e) => JSON.stringify(e)))
  })

  test("a NON-refusal stream is untouched in suppression mode (the gate really is the refusal)", () => {
    // Positive control: if this went through the suppression path, the assertions above would be
    // proving nothing about the gate.
    const events = [
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]
    const out = drive(events, policy("end_turn"))
    expect(out.map((f) => f.data)).toEqual(events.map((e) => JSON.stringify(e)))
  })

  test("a refusal WITH real text is not suppressed (contentless gate, not stop_reason alone)", () => {
    const events = [
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answer" } },
      { type: "content_block_stop", index: 0 },
      refusalDelta(CYBER_CATEGORY, { output_tokens: 9 }),
      { type: "message_stop" },
    ]
    const out = drive(events, policy("end_turn"))
    expect(out.map((f) => f.data)).toEqual(events.map((e) => JSON.stringify(e)))
  })
})

describe("category rendering across the three real samples", () => {
  test("named categories render verbatim; an upstream null renders `uncategorized`", () => {
    const rendered = (stopDetails: unknown): string => {
      const out = drive([messageStart, refusalDelta(stopDetails, { output_tokens: 1 })], policy("end_turn"))
      return JSON.parse(out[2].data ?? "").delta.text as string
    }
    expect(rendered(CYBER_CATEGORY)).toBe("blocked c=cyber")
    expect(rendered(BIO_CATEGORY)).toBe("blocked c=bio")
    expect(rendered(NULL_CATEGORY)).toBe("blocked c=uncategorized")
    expect(rendered(undefined)).toBe("blocked c=unknown")
    // A malformed empty category must not reach the client as an empty parenthetical — this text is
    // baked into the conversation, so "（拒绝类别：）" would be visible to the user forever.
    expect(rendered({ type: "refusal", category: "" })).toBe("blocked c=unknown")
  })
})
