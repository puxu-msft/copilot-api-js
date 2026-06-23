/**
 * Unit tests for the Anthropic thinking-only-refusal recovery (response-side).
 *
 * Covers the pure helpers, the streaming `createRefusalRecoverer` state machine
 * (passthrough + synthesize-at-refusal, index tracking, gate), and the
 * non-streaming `recoverRefusalInResponse`. The driver/handler integration is
 * locked separately by tests/anthropic/response-rewrite-golden.http.test.ts.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type {
  //
  RawMessageDeltaEvent,
  StreamEvent,
} from "~/types/api/anthropic"

import {
  //
  buildSyntheticTextFrames,
  createRefusalRecoverer,
  isThinkingOnlyRefusal,
  recoverRefusalInResponse,
  REFUSAL_RECOVERY_TEXT,
  rewriteRefusalMessageDelta,
} from "~/lib/anthropic/recover-refusal"

/** Build an `(parsed, raw)` pair the recoverer's processEvent expects. */
function frame(obj: Record<string, unknown>): { parsed: StreamEvent; raw: ServerSentEventMessage } {
  return { parsed: obj as unknown as StreamEvent, raw: { data: JSON.stringify(obj) } }
}

/** Drive a sequence of plain event objects through a recoverer; return the forwarded data strings. */
function run(events: Array<Record<string, unknown>>, onRecover?: () => void): Array<string> {
  const recoverer = createRefusalRecoverer({ onRecover })
  const out: Array<string> = []
  for (const ev of events) {
    const { parsed, raw } = frame(ev)
    for (const f of recoverer.processEvent(parsed, raw)) out.push(f.data ?? "")
  }
  return out
}

const thinkingStart = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }
const sigDelta = { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } }
const thinkingStop = { type: "content_block_stop", index: 0 }
const messageStop = { type: "message_stop" }
const refusalDelta = {
  type: "message_delta",
  delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "x" }, stop_sequence: null },
  usage: { output_tokens: 9 },
}

describe("isThinkingOnlyRefusal", () => {
  test("true only for refusal stop_reason with no real content", () => {
    expect(isThinkingOnlyRefusal("refusal", false)).toBe(true)
    expect(isThinkingOnlyRefusal("refusal", true)).toBe(false)
    expect(isThinkingOnlyRefusal("end_turn", false)).toBe(false)
    expect(isThinkingOnlyRefusal("tool_use", false)).toBe(false)
    expect(isThinkingOnlyRefusal(null, false)).toBe(false)
    expect(isThinkingOnlyRefusal(undefined, false)).toBe(false)
  })
})

describe("buildSyntheticTextFrames", () => {
  test("emits start → delta → stop at the given index with event lines matching type", () => {
    const frames = buildSyntheticTextFrames(2)
    expect(frames.map((f) => f.event)).toEqual(["content_block_start", "content_block_delta", "content_block_stop"])
    expect(frames.map((f) => JSON.parse(f.data ?? ""))).toEqual([
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: REFUSAL_RECOVERY_TEXT } },
      { type: "content_block_stop", index: 2 },
    ])
  })
})

describe("rewriteRefusalMessageDelta", () => {
  test("flips stop_reason to end_turn, clears stop_details, preserves usage/stop_sequence, does not mutate input", () => {
    const input = {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "x" }, stop_sequence: "S" },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageDeltaEvent
    const out = rewriteRefusalMessageDelta(input)
    expect(out.delta.stop_reason).toBe("end_turn")
    expect(out.delta.stop_details).toBeNull()
    expect(out.delta.stop_sequence).toBe("S")
    expect(out.usage).toEqual({ output_tokens: 9 } as never)
    // input untouched (immutability)
    expect(input.delta.stop_reason).toBe("refusal")
    expect(input.delta.stop_details).toEqual({ type: "refusal", explanation: "x" } as never)
  })
})

describe("createRefusalRecoverer (streaming)", () => {
  test("thinking-only refusal: passes thinking frames, synthesizes text at maxIndex+1, rewrites delta to end_turn", () => {
    let recovered = 0
    const out = run([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop, refusalDelta, messageStop], () => recovered++)
    const parsed = out.map((d) => JSON.parse(d))
    // thinking frames verbatim
    expect(parsed.slice(0, 4)).toEqual([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop])
    // synthetic text block at index 1 (thinking was index 0)
    expect(parsed[4]).toEqual({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
    expect(parsed[5]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: REFUSAL_RECOVERY_TEXT } })
    expect(parsed[6]).toEqual({ type: "content_block_stop", index: 1 })
    // rewritten message_delta: end_turn, stop_details cleared
    expect(parsed[7]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_details: null, stop_sequence: null },
      usage: { output_tokens: 9 },
    })
    expect(parsed[8]).toEqual(messageStop)
    expect(recovered).toBe(1)
  })

  test("normal end_turn stream passes through byte-identical (gate never fires)", () => {
    let recovered = 0
    const events = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      messageStop,
    ]
    const out = run(events, () => recovered++)
    expect(out).toEqual(events.map((e) => JSON.stringify(e)))
    expect(recovered).toBe(0)
  })

  test("refusal WITH a real text block: gate closed, passes through unchanged", () => {
    let recovered = 0
    const events = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
      refusalDelta,
      messageStop,
    ]
    const out = run(events, () => recovered++)
    expect(out).toEqual(events.map((e) => JSON.stringify(e)))
    expect(recovered).toBe(0)
  })

  test("two thinking blocks → synthetic text at index 2", () => {
    const out = run([
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_stop", index: 1 },
      refusalDelta,
      messageStop,
    ])
    const synthStart = JSON.parse(out[5])
    expect(synthStart).toEqual({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } })
  })

  test("refusal with NO content blocks → synthetic text at index 0", () => {
    const out = run([{ type: "message_start" }, refusalDelta, messageStop])
    expect(JSON.parse(out[1])).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    expect(JSON.parse(out[4])).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_details: null, stop_sequence: null },
      usage: { output_tokens: 9 },
    })
  })
})

describe("recoverRefusalInResponse (non-streaming)", () => {
  const base = { id: "m", type: "message", role: "assistant", model: "claude-opus-4.8", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } }

  test("thinking-only refusal: appends text block, end_turn, clears stop_details", () => {
    const resp = {
      ...base,
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "x" },
      content: [{ type: "thinking", thinking: "", signature: "S" }],
    } as unknown as AnthropicMessageResponse
    const out = recoverRefusalInResponse(resp)
    expect(out.stop_reason).toBe("end_turn")
    expect(out.stop_details).toBeNull()
    expect(out.content).toEqual([
      { type: "thinking", thinking: "", signature: "S" },
      { type: "text", text: REFUSAL_RECOVERY_TEXT },
    ] as never)
  })

  test("refusal with existing text/tool_use: returns identity", () => {
    const withText = { ...base, stop_reason: "refusal", content: [{ type: "text", text: "hi" }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(withText)).toBe(withText)
    const withTool = { ...base, stop_reason: "refusal", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(withTool)).toBe(withTool)
  })

  test("non-refusal: returns identity", () => {
    const resp = { ...base, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "S" }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(resp)).toBe(resp)
  })

  test("refusal with empty content: appends a single text block", () => {
    const resp = { ...base, stop_reason: "refusal", content: [] } as unknown as AnthropicMessageResponse
    const out = recoverRefusalInResponse(resp)
    expect(out.stop_reason).toBe("end_turn")
    expect(out.content).toEqual([{ type: "text", text: REFUSAL_RECOVERY_TEXT }] as never)
  })
})
