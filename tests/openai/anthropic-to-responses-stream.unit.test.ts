/**
 * Anthropic SSE stream → Responses SSE stream DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.2, Phase 4 subtask F) — single-hop streaming translation, replacing the two-hop
 * `Anthropic→CC(hub)→Responses` per-frame translation for the `(openai-responses client, /v1/messages)`
 * REVERSE streaming leg.
 *
 * Two oracles (mirrors subtask C's discipline, `responses-to-anthropic-stream.unit.test.ts`):
 *   1. SELF golden — `renderAll` drives renderFrame/flush and asserts the exact Responses lifecycle event
 *      sequence + output_index allocation (this translator's OWN monotone counter, never a CC index — the
 *      recorded trap `cc-to-anthropic-stream.ts:253-254` avoided here) + the self-contained terminal meta.
 *   2. INDEPENDENT Responses accumulator oracle (`accumulateResponsesStreamEvent`, the SAME real consumer
 *      primitive the production seam test `reverse-responses-messages.it.test.ts` uses) — feeds the
 *      synthesized events into the actual Responses-format accumulator and asserts the reconstructed
 *      content/tool-calls/status, independent of this file's own emission logic.
 *
 * Golden-two-zone (RFC R-GOLDEN-TWO-ZONE): equivalence-zone assertions (text/tool_use lifecycle shape) are
 * self-consistent with the non-streaming bridge (subtask E) — no client-observable difference from the old
 * two-hop path for these fields. Improvement-zone assertions (reasoning rendering, the 2 Anthropic-only
 * stop_reason values) use the independent Responses accumulator oracle, NOT locked to the old lossy
 * CC-intermediate golden.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

import { extractClaudeSignature } from "~/lib/anthropic/claude-signature-carrier"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
  finalizeResponsesContent,
} from "~/lib/openai/responses-stream-accumulator"
import { createAnthropicToResponsesStreamTranslator } from "~/lib/openai/translate/anthropic-to-responses-stream"

const ctx = { responseId: "resp_abc", itemId: "item_abc", clientModel: "claude-opus-4.8" }

// ── helpers ──────────────────────────────────────────────────────────────────

/** An Anthropic SSE event frame (the shape upstream sends). */
function anthropicEvent(obj: unknown): ServerSentEventMessage {
  return { data: JSON.stringify(obj), event: (obj as { type: string }).type }
}

/** Drive the translator over a list of Anthropic events + flush; return the ordered Responses frames. */
function renderAll(events: Array<ServerSentEventMessage>, modelId = "claude-opus-4.8", opts?: { stripThinkingSignature?: boolean }) {
  const t = createAnthropicToResponsesStreamTranslator(modelId, ctx, opts)
  const out: Array<ServerSentEventMessage> = []
  for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return out
}

/** Drive the translator AND return the terminal meta (getMeta reads the translator's own running state). */
function renderAllWithMeta(events: Array<ServerSentEventMessage>, modelId = "claude-opus-4.8") {
  const t = createAnthropicToResponsesStreamTranslator(modelId, ctx)
  const out: Array<ServerSentEventMessage> = []
  for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return { frames: out, meta: t.getMeta() }
}

/** Parse a frame's JSON data. */
function data(frame: ServerSentEventMessage): Record<string, unknown> {
  return JSON.parse(frame.data ?? "{}") as Record<string, unknown>
}

/** INDEPENDENT ORACLE: feed the synthesized frames into the REAL Responses stream accumulator. */
function responsesAccumulate(frames: Array<ServerSentEventMessage>): ReturnType<typeof createResponsesStreamAccumulator> {
  const acc = createResponsesStreamAccumulator()
  for (const f of frames) {
    if (!f.data) continue
    accumulateResponsesStreamEvent(JSON.parse(f.data) as ResponsesStreamEvent, acc)
  }
  return acc
}

// ── the Anthropic SSE event shapes upstream emits ─────────────────────────────

function messageStart(model = "claude-opus-4.8", usage: Record<string, unknown> = { input_tokens: 15, output_tokens: 0 }): ServerSentEventMessage {
  return anthropicEvent({
    type: "message_start",
    message: { id: "msg_r", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage },
  })
}
function textBlockStart(index: number): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } })
}
function textDelta(index: number, text: string): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } })
}
function toolUseBlockStart(index: number, id: string, name: string): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } })
}
function toolArgsDelta(index: number, partialJson: string): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } })
}
function thinkingBlockStart(index: number): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })
}
function thinkingDelta(index: number, text: string): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } })
}
function signatureDelta(index: number, signature: string): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_delta", index, delta: { type: "signature_delta", signature } })
}
function blockStop(index: number): ServerSentEventMessage {
  return anthropicEvent({ type: "content_block_stop", index })
}
function messageDelta(stopReason: string | null, usage: Record<string, unknown> = {}): ServerSentEventMessage {
  return anthropicEvent({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage })
}
function messageStop(): ServerSentEventMessage {
  return anthropicEvent({ type: "message_stop" })
}

describe("anthropic-to-responses-stream — text (equivalence zone)", () => {
  test("text-only turn produces the full Responses lifecycle sequence", () => {
    const frames = renderAll([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "It is "),
      textDelta(0, "sunny."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ])
    const types = frames.map((f) => data(f).type)
    expect(types[0]).toBe("response.created")
    expect(types).toContain("response.content_part.added")
    expect(types).toContain("response.output_text.delta")
    expect(types.at(-1)).toBe("response.completed")
  })

  test("INDEPENDENT ORACLE: the real Responses accumulator reconstructs the full text + completed status", () => {
    const frames = renderAll([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "It is "),
      textDelta(0, "sunny."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ])
    const acc = responsesAccumulate(frames)
    expect(finalizeResponsesContent(acc)).toBe("It is sunny.")
    expect(acc.status).toBe("completed")
  })

  test("redacted_thinking / server_tool_use blocks are dropped (no Responses output-item equivalent on this leg) — never throws, surrounding turns still land", () => {
    const frames = renderAll([
      messageStart(),
      anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }),
      anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "should be dropped" } }),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "visible answer"),
      blockStop(1),
      messageDelta("end_turn"),
    ])
    const acc = responsesAccumulate(frames)
    expect(finalizeResponsesContent(acc)).toBe("visible answer")
    expect(frames.some((f) => data(f).type === "response.output_item.added" && (data(f).item as { type: string }).type === "reasoning")).toBe(false)
  })
})

describe("anthropic-to-responses-stream — tool_use (equivalence zone, native output_index — never a CC index)", () => {
  test("tool_use block → function_call lifecycle events with the OWN monotone output_index (not the raw Anthropic block index)", () => {
    const frames = renderAll([
      messageStart(),
      toolUseBlockStart(0, "toolu_a", "get_weather"),
      toolArgsDelta(0, '{"city":"SF"}'),
      blockStop(0),
      messageDelta("tool_use"),
    ])
    const added = frames.find((f) => data(f).type === "response.output_item.added")!
    expect(data(added).output_index).toBe(0)
    expect((data(added).item as { name: string }).name).toBe("get_weather")
  })

  test("INDEPENDENT ORACLE: the real Responses accumulator reconstructs the tool call id/name/arguments", () => {
    const frames = renderAll([
      messageStart(),
      toolUseBlockStart(0, "toolu_a", "get_weather"),
      toolArgsDelta(0, '{"city":"SF"}'),
      blockStop(0),
      messageDelta("tool_use"),
    ])
    const acc = responsesAccumulate(frames)
    expect(acc.toolCalls).toEqual([{ id: "toolu_a", callId: "toolu_a", name: "get_weather", arguments: '{"city":"SF"}' }])
  })

  test("text-then-tool: output_index allocated in arrival order (0 for text, 1 for tool), never the raw Anthropic index verbatim", () => {
    const frames = renderAll([
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Let me check."),
      blockStop(0),
      toolUseBlockStart(1, "toolu_b", "get_weather"),
      toolArgsDelta(1, "{}"),
      blockStop(1),
      messageDelta("tool_use"),
    ])
    const outputItemEvents = frames.filter(
      (f) => data(f).type === "response.output_item.added" || (data(f).type === "response.content_part.added" && (data(f).output_index as number) === 0),
    )
    const outputIndexes = [...new Set(frames.filter((f) => data(f).type === "response.output_item.added").map((f) => data(f).output_index))]
    expect(outputIndexes).toEqual([1])
    void outputItemEvents
  })
})

describe("anthropic-to-responses-stream — reasoning rendering (IMPROVEMENT ZONE, R-DIRECTION-ASYMMETRY — real signature carried byte-exact via claude-signature-carrier, Phase 5)", () => {
  test("thinking block streams as a leading reasoning item summary via response.reasoning_summary_text.delta", () => {
    const frames = renderAll([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "step 1... "),
      thinkingDelta(0, "step 2..."),
      signatureDelta(0, "REAL-CLAUDE-SIGNATURE-abc123"),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "the answer"),
      blockStop(1),
      messageDelta("end_turn"),
    ])
    const reasoningAdded = frames.find((f) => data(f).type === "response.output_item.added" && (data(f).item as { type: string }).type === "reasoning")
    expect(reasoningAdded).toBeDefined()
    const summaryDeltas = frames.filter((f) => data(f).type === "response.reasoning_summary_text.delta")
    expect(summaryDeltas.map((f) => data(f).delta as string).join("")).toBe("step 1... step 2...")
  })

  test("the REAL Claude signature (via signature_delta) is carried byte-exact into the closed reasoning item's encrypted_content (Phase 5 round-trip carrier) — never as bare plaintext on the wire", () => {
    const frames = renderAll([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "reasoning text"),
      signatureDelta(0, "REAL-SIGNATURE-xyz-do-not-leak-bare"),
      blockStop(0),
      messageDelta("end_turn"),
    ])
    const wire = frames.map((f) => f.data ?? "").join("")
    // The RAW signature never appears verbatim (it's base64url-encoded inside the carrier) — this is a
    // side-effect of the carrier's encoding, not the mechanism that protects it (R-DIRECTION-ASYMMETRY is
    // about which primitive owns the value, not obscurity).
    expect(wire).not.toContain("REAL-SIGNATURE-xyz-do-not-leak-bare")
    const doneEvent = frames.find((f) => data(f).type === "response.output_item.done" && (data(f).item as { type: string }).type === "reasoning")
    expect(doneEvent).toBeDefined()
    const item = data(doneEvent as ServerSentEventMessage).item as { encrypted_content?: string }
    expect(item.encrypted_content).toBeDefined()
    expect(extractClaudeSignature(item.encrypted_content)).toBe("REAL-SIGNATURE-xyz-do-not-leak-bare")
  })

  test("a thinking block with EMPTY plaintext (opus/sonnet convention — real reasoning lives entirely in the signature, probe (e)) still emits a reasoning item carrying the signature — never silently dropped", () => {
    const frames = renderAll([messageStart(), thinkingBlockStart(0), signatureDelta(0, "ENCRYPTED-ONLY-NO-PLAINTEXT-SIG"), blockStop(0), messageDelta("end_turn")])
    const doneEvent = frames.find((f) => data(f).type === "response.output_item.done" && (data(f).item as { type: string }).type === "reasoning")
    expect(doneEvent).toBeDefined()
    const item = data(doneEvent as ServerSentEventMessage).item as { summary: Array<unknown>; encrypted_content?: string }
    expect(item.summary).toEqual([])
    expect(extractClaudeSignature(item.encrypted_content)).toBe("ENCRYPTED-ONLY-NO-PLAINTEXT-SIG")
  })

  test("INDEPENDENT ORACLE: the real Responses accumulator's toolCallMap/content are unaffected by an interleaved reasoning item (no cross-contamination)", () => {
    const frames = renderAll([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "thinking"),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "answer text"),
      blockStop(1),
      messageDelta("end_turn"),
    ])
    const acc = responsesAccumulate(frames)
    expect(finalizeResponsesContent(acc)).toBe("answer text")
  })
})

describe("anthropic-to-responses-stream — RFC §4.3 scenario A/B (Phase 5 model_translation wiring)", () => {
  test("scenario B (stripThinkingSignature=true) NEVER populates encrypted_content — plaintext summary still streams", () => {
    const frames = renderAll(
      [messageStart(), thinkingBlockStart(0), thinkingDelta(0, "still shown"), signatureDelta(0, "SHOULD-NOT-BE-CARRIED"), blockStop(0), messageDelta("end_turn")],
      "claude-opus-4.8",
      { stripThinkingSignature: true },
    )
    const doneEvent = frames.find((f) => data(f).type === "response.output_item.done" && (data(f).item as { type: string }).type === "reasoning")
    const item = data(doneEvent as ServerSentEventMessage).item as { summary: Array<{ type: string; text: string }>; encrypted_content?: string }
    expect(item.encrypted_content).toBeUndefined()
    expect(item.summary).toEqual([{ type: "summary_text", text: "still shown" }])
  })

  test("scenario A (default, no opts) DOES populate encrypted_content — the default is full round-trip", () => {
    const frames = renderAll([messageStart(), thinkingBlockStart(0), thinkingDelta(0, "shown"), signatureDelta(0, "REAL-SIG"), blockStop(0), messageDelta("end_turn")])
    const doneEvent = frames.find((f) => data(f).type === "response.output_item.done" && (data(f).item as { type: string }).type === "reasoning")
    const item = data(doneEvent as ServerSentEventMessage).item as { encrypted_content?: string }
    expect(extractClaudeSignature(item.encrypted_content)).toBe("REAL-SIG")
  })
})

describe("anthropic-to-responses-stream — stop_reason → status (IMPROVEMENT ZONE, single-hop, reused from subtask E)", () => {
  test("end_turn → completed", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, "hi"), blockStop(0), messageDelta("end_turn"), messageStop()])
    expect(meta.status).toBe("completed")
  })

  test("max_tokens → incomplete + max_output_tokens reason", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, "hi"), blockStop(0), messageDelta("max_tokens"), messageStop()])
    expect(meta.status).toBe("incomplete")
    expect(meta.incompleteReason).toBe("max_output_tokens")
  })

  test("pause_turn (Anthropic-only) → incomplete + an HONEST 'pause_turn' reason (reused from subtask E's mapping, not re-derived)", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, "hi"), blockStop(0), messageDelta("pause_turn"), messageStop()])
    expect(meta.status).toBe("incomplete")
    expect(meta.incompleteReason).toBe("pause_turn")
  })

  test("refusal (Anthropic-only) → incomplete + an HONEST 'refusal' reason (NOT content_filter)", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, ""), blockStop(0), messageDelta("refusal"), messageStop()])
    expect(meta.status).toBe("incomplete")
    expect(meta.incompleteReason).toBe("refusal")
  })

  test("tool_use forces completed regardless of downstream stop_reason quirks", () => {
    const { meta } = renderAllWithMeta([
      messageStart(),
      toolUseBlockStart(0, "t1", "f"),
      toolArgsDelta(0, "{}"),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ])
    expect(meta.status).toBe("completed")
  })
})

describe("anthropic-to-responses-stream — self-contained terminal meta (sawMessageStop, no CC accumulator)", () => {
  test("message_stop seen → sawMessageStop true", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, "hi"), blockStop(0), messageDelta("end_turn"), messageStop()])
    expect(meta.sawMessageStop).toBe(true)
  })

  test("no message_stop event (truncated stream) → sawMessageStop false (the truncation signal, mirrors the CC-leg convention)", () => {
    const { meta } = renderAllWithMeta([messageStart(), textBlockStart(0), textDelta(0, "partial")])
    expect(meta.sawMessageStop).toBe(false)
  })
})

describe("anthropic-to-responses-stream — terminal usage (MAJOR fix: message_start usage was dropped → client saw null)", () => {
  // Phase 4 reviewer MAJOR (false-green, Phase 3 same-class recurrence): Anthropic reports input_tokens +
  // cache legs FIRST/ONLY on message_start; the terminal message_delta usually carries just output_tokens.
  // The pre-fix translator read only msg.model on message_start → totalInput undefined → NaN → client usage null.
  test("input_tokens + cache_read from message_start are grossed-up onto response.completed.usage (was NaN→null pre-fix)", () => {
    const frames = renderAll([
      messageStart("claude-opus-4.8", { input_tokens: 15, output_tokens: 0, cache_read_input_tokens: 5 }),
      textBlockStart(0),
      textDelta(0, "hi"),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 8 }),
      messageStop(),
    ])
    const completed = frames.find((f) => data(f).type === "response.completed")
    expect(completed).toBeDefined()
    const usage = (data(completed!).response as { usage: unknown }).usage
    // Anthropic input_tokens is net-of-cache (15); Responses input_tokens is total-including-cache (15+5=20).
    expect(usage).toEqual({ input_tokens: 20, output_tokens: 8, total_tokens: 28, input_tokens_details: { cached_tokens: 5 } })
  })

  test("reasoning_tokens (thinking_tokens) from message_delta is forwarded onto the terminal usage (richest-data-flow)", () => {
    const frames = renderAll([
      messageStart("claude-opus-4.8", { input_tokens: 10, output_tokens: 0 }),
      textBlockStart(0),
      textDelta(0, "hi"),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 12, output_tokens_details: { thinking_tokens: 7 } }),
      messageStop(),
    ])
    const completed = frames.find((f) => data(f).type === "response.completed")
    const usage = (data(completed!).response as { usage: { output_tokens_details?: unknown } }).usage
    expect(usage.output_tokens_details).toEqual({ reasoning_tokens: 7 })
  })
})

describe("anthropic-to-responses-stream — unparseable / malformed frames + error propagation (never-swallow)", () => {
  test("an unparseable JSON frame is skipped, not thrown", () => {
    const t = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", ctx)
    expect(() => t.renderFrame({ data: "not json {{{", event: "message" })).not.toThrow()
  })

  test("[DONE] / empty-data frames are no-ops", () => {
    const t = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", ctx)
    expect(t.renderFrame({ data: "[DONE]", event: "message" })).toEqual([])
    expect(t.renderFrame({ data: "", event: "message" })).toEqual([])
  })

  test("a terminal error event throws (propagates to the caller, never swallowed)", () => {
    const t = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", ctx)
    expect(() => t.renderFrame(anthropicEvent({ type: "error", error: { type: "overloaded_error", message: "upstream overloaded" } }))).toThrow(
      /upstream overloaded/,
    )
  })

  test("flush is idempotent (a second call yields no additional frames)", () => {
    const t = createAnthropicToResponsesStreamTranslator("claude-opus-4.8", ctx)
    for (const s of t.renderFrame(messageStart())) void s
    const first = t.flush()
    const second = t.flush()
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual([])
  })
})
