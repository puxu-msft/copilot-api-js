/**
 * Unit tests for the Anthropic contentless-refusal rewriter (response-side).
 *
 * Covers the streaming `createRefusalRewriter` state machine in both suppression (`end_turn`)
 * and `error` dispositions, and the non-streaming `recoverRefusalInResponse`. The pure parsing
 * helpers live in refusal-detail.unit.test.ts. The driver/handler integration is locked separately by
 * tests/anthropic/response-rewrite-golden.http.test.ts.
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
  createRefusalRewriter,
  recoverRefusalInResponse,
  rewriteRefusalMessageDelta,
} from "~/lib/anthropic/recover-refusal"

/** Static vars a factory is constructed with (model/request_id known at stream start). */
const STATIC = { model: "claude-opus-4.8", request_id: "req_1" }

/** Build an `(parsed, raw)` pair the recoverer's processEvent expects. */
function frame(obj: Record<string, unknown>): { parsed: StreamEvent; raw: ServerSentEventMessage } {
  return { parsed: obj as unknown as StreamEvent, raw: { data: JSON.stringify(obj) } }
}

/** Hand-written suppression text — deliberately NOT the production constant (an expected value
 *  imported from the code under test goes green when both change together). */
const SUPPRESS_TEXT = "suppressed: category={refusal_category}"
/** What SUPPRESS_TEXT renders to for the fixtures below (stop_details carries no category). */
const SUPPRESS_RENDERED = "suppressed: category=unknown"
const ERROR_TEXT = "denied: category={refusal_category}"
const ERROR_RENDERED = "denied: category=unknown"

/** Drive a sequence of plain event objects through a suppression rewriter; return forwarded data strings. */
function run(events: Array<Record<string, unknown>>, onRecover?: () => void): Array<string> {
  const recoverer = createRefusalRewriter({
    mode: "end_turn",
    endTurnText: SUPPRESS_TEXT,
    errorMessage: "",
    errorType: "api_error",
    staticVars: STATIC,
    onObserve: onRecover ? () => onRecover() : undefined,
  })
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

describe("buildSyntheticTextFrames", () => {
  test("emits start → delta → stop at the given index carrying the passed text", () => {
    const frames = buildSyntheticTextFrames(2, "hello")
    expect(frames.map((f) => f.event)).toEqual(["content_block_start", "content_block_delta", "content_block_stop"])
    expect(frames.map((f) => JSON.parse(f.data ?? ""))).toEqual([
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hello" } },
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
  test("contentless refusal: passes thinking frames, synthesizes text at maxIndex+1, rewrites delta to end_turn", () => {
    let recovered = 0
    const out = run([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop, refusalDelta, messageStop], () => recovered++)
    const parsed = out.map((d) => JSON.parse(d))
    // thinking frames verbatim
    expect(parsed.slice(0, 4)).toEqual([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop])
    // synthetic text block at index 1 (thinking was index 0)
    expect(parsed[4]).toEqual({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })
    expect(parsed[5]).toEqual({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: SUPPRESS_RENDERED } })
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

  test("renders {thinking_tokens} as `unknown` when the upstream sent no breakdown, and {model}", () => {
    const recoverer = createRefusalRewriter({ mode: "end_turn", endTurnText: "t={thinking_tokens} m={model}", errorMessage: "", errorType: "api_error", staticVars: STATIC })
    const { parsed, raw } = frame(refusalDelta) // usage.output_tokens = 9
    const out = recoverer.processEvent(parsed, raw)
    // synthetic text delta (index 0) carries the rendered template
    const textDelta = JSON.parse(out[1].data ?? "")
    expect(textDelta).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "t=unknown m=claude-opus-4.8" } })
  })

  test("empty template appends NO text block, only flips stop_reason to end_turn", () => {
    const recoverer = createRefusalRewriter({ mode: "end_turn", endTurnText: "", errorMessage: "", errorType: "api_error", staticVars: STATIC })
    const { parsed, raw } = frame(refusalDelta)
    const out = recoverer.processEvent(parsed, raw)
    // exactly one frame: the rewritten end_turn delta, no synthetic text block
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0].data ?? "")).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_details: null, stop_sequence: null },
      usage: { output_tokens: 9 },
    })
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

describe("createRefusalErrorEmitter (streaming, error mode)", () => {
  /** Drive events through a default error-emitter; return the forwarded frames (event + data preserved). */
  function runEmitter(events: Array<Record<string, unknown>>): Array<ServerSentEventMessage> {
    const emitter = createRefusalRewriter({ mode: "error", endTurnText: "", errorMessage: ERROR_TEXT, errorType: "api_error", staticVars: STATIC })
    const out: Array<ServerSentEventMessage> = []
    for (const ev of events) {
      const { parsed, raw } = frame(ev)
      for (const f of emitter.processEvent(parsed, raw)) out.push(f)
    }
    return out
  }

  test("contentless refusal: replaces the delta with an error frame, suppresses message_stop", () => {
    const out = runEmitter([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop, refusalDelta, messageStop])
    // 4 thinking frames pass verbatim, the refusal delta is REPLACED by 1 error frame, message_stop is SUPPRESSED → 5 total
    expect(out).toHaveLength(5)
    expect(out.slice(0, 4).map((f) => JSON.parse(f.data ?? ""))).toEqual([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop])
    // the error frame carries an `event: error` line (else the Anthropic SDK drops it) + canonical body
    expect(out[4].event).toBe("error")
    expect(JSON.parse(out[4].data ?? "")).toEqual({ type: "error", error: { type: "api_error", message: ERROR_RENDERED } })
    // the original refusal delta + message_stop never reach the client (pure reshape; no ctx/feature
    // side effects — the handler's complete branch owns observability)
    expect(out.some((f) => (f.data ?? "").includes('"stop_reason":"refusal"'))).toBe(false)
    expect(out.some((f) => (f.data ?? "").includes('"message_stop"'))).toBe(false)
  })

  test("renders a custom message template + custom error type into the error frame", () => {
    const emitter = createRefusalRewriter({ mode: "error", endTurnText: "", errorMessage: "denied m={model} t={thinking_tokens}", errorType: "custom_type", staticVars: STATIC })
    const { parsed, raw } = frame(refusalDelta) // usage.output_tokens = 9
    const out = emitter.processEvent(parsed, raw)
    expect(out).toHaveLength(1)
    expect(out[0].event).toBe("error")
    expect(JSON.parse(out[0].data ?? "")).toEqual({ type: "error", error: { type: "custom_type", message: "denied m=claude-opus-4.8 t=unknown" } })
  })

  test("empty error type falls back to api_error", () => {
    const emitter = createRefusalRewriter({ mode: "error", endTurnText: "", errorMessage: "x", errorType: "", staticVars: STATIC })
    const { parsed, raw } = frame(refusalDelta)
    const out = emitter.processEvent(parsed, raw)
    expect(JSON.parse(out[0].data ?? "").error.type).toBe("api_error")
  })

  test("normal end_turn stream passes through byte-identical, including message_stop (gate never fires)", () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      messageStop,
    ]
    const out = runEmitter(events)
    expect(out.map((f) => f.data)).toEqual(events.map((e) => JSON.stringify(e)))
    expect(out.some((f) => f.event === "error")).toBe(false)
  })

  test("refusal WITH a real text block: gate closed, passes through unchanged (message_stop forwarded)", () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "content_block_stop", index: 0 },
      refusalDelta,
      messageStop,
    ]
    const out = runEmitter(events)
    expect(out.map((f) => f.data)).toEqual(events.map((e) => JSON.stringify(e)))
    expect(out.some((f) => f.event === "error")).toBe(false)
  })

  test("refusal with NO message_stop (truncation-compound): emits exactly one error frame", () => {
    // Compound edge: refusal delta then a clean EOF without message_stop. The emitter emits the
    // error frame at the delta and there is no trailing frame to suppress — it must NOT double-emit.
    const out = runEmitter([{ type: "message_start" }, thinkingStart, sigDelta, thinkingStop, refusalDelta])
    expect(out.filter((f) => f.event === "error")).toHaveLength(1)
  })
})

describe("recoverRefusalInResponse (non-streaming)", () => {
  const base = { id: "m", type: "message", role: "assistant", model: "claude-opus-4.8", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } }

  test("contentless refusal: appends the rendered text block, end_turn, clears stop_details", () => {
    const resp = {
      ...base,
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "x" },
      content: [{ type: "thinking", thinking: "", signature: "S" }],
    } as unknown as AnthropicMessageResponse
    const out = recoverRefusalInResponse(resp, "hi opus")
    expect(out.stop_reason).toBe("end_turn")
    expect(out.stop_details).toBeNull()
    expect(out.content).toEqual([
      { type: "thinking", thinking: "", signature: "S" },
      { type: "text", text: "hi opus" },
    ] as never)
  })

  test("empty rendered text appends NO block, only flips stop_reason", () => {
    const resp = {
      ...base,
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "x" },
      content: [{ type: "thinking", thinking: "", signature: "S" }],
    } as unknown as AnthropicMessageResponse
    const out = recoverRefusalInResponse(resp, "")
    expect(out.stop_reason).toBe("end_turn")
    expect(out.stop_details).toBeNull()
    expect(out.content).toEqual([{ type: "thinking", thinking: "", signature: "S" }] as never)
  })

  test("refusal with existing text/tool_use: returns identity", () => {
    const withText = { ...base, stop_reason: "refusal", content: [{ type: "text", text: "hi" }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(withText, "x")).toBe(withText)
    const withTool = { ...base, stop_reason: "refusal", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(withTool, "x")).toBe(withTool)
  })

  test("non-refusal: returns identity", () => {
    const resp = { ...base, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "S" }] } as unknown as AnthropicMessageResponse
    expect(recoverRefusalInResponse(resp, "x")).toBe(resp)
  })

  test("refusal with empty content: appends a single rendered text block", () => {
    const resp = { ...base, stop_reason: "refusal", content: [] } as unknown as AnthropicMessageResponse
    const out = recoverRefusalInResponse(resp, "recovered")
    expect(out.stop_reason).toBe("end_turn")
    expect(out.content).toEqual([{ type: "text", text: "recovered" }] as never)
  })
})
