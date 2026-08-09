/**
 * Responses SSE stream → Anthropic Messages SSE stream DIRECT bridge (RFC
 * 2026-07-14-anthropic-responses-direct-bridge §3/§4.1, Phase 3 subtask C).
 *
 * Two oracles (mirrors `cc-to-anthropic-stream.unit.test.ts`'s discipline):
 *   1. SELF golden — `renderAll` drives renderFrame/flush and asserts the exact Anthropic frame sequence
 *      + block indices (native Responses `output_index`, never a CC-style remapped index — the recorded
 *      trap `cc-to-anthropic-stream.ts:253-254` avoided here), the N1 event-line invariant, and the
 *      self-contained terminal meta (this translator's OWN running state, not a CC accumulator's).
 *   2. INDEPENDENT Anthropic SDK oracle (`sdkAccumulate`) — feeds the synthesized wire into the REAL
 *      `@anthropic-ai/sdk` `Stream.fromSSEResponse` decoder (the exact one Claude Code uses) and
 *      reconstructs the accumulated `Message` from ONLY the events that survived the real decoder — a
 *      self-consistent golden cannot catch an event-less frame the SDK silently drops (N1).
 *
 * Golden-two-zone (RFC R-GOLDEN-TWO-ZONE): equivalence-zone assertions (text/tool_use block shape, usage
 * numeric fields) are self-consistent with the non-streaming bridge (subtask B) — no CLIENT-OBSERVABLE
 * byte difference from the old two-hop path for these fields. Improvement-zone assertions (reasoning
 * passthrough via the `.done` capture fix, NOT locked to the old lossy `responses-to-cc-stream.ts:58-66`
 * `.added` capture) use the REAL SDK accumulator as the independent oracle.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponsesOutputItem } from "~/types/api/openai-responses"

import { createResponsesToAnthropicStreamTranslator } from "~/lib/openai/translate/responses-to-anthropic-stream"

import { accumulateAnthropic, assertAnthropicEventLineInvariant } from "../helpers/protocol-oracles"

// ── helpers ──────────────────────────────────────────────────────────────────

/** A Responses SSE event frame (the shape upstream sends). */
function rEvent(obj: unknown): ServerSentEventMessage {
  return { data: JSON.stringify(obj), event: "message" }
}

/** Drive the translator over a list of Responses events + flush; return the ordered Anthropic frames. */
function renderAll(events: Array<ServerSentEventMessage>, modelId = "gpt-5.5", opts?: { stripThinkingSignature?: boolean }): Array<ServerSentEventMessage> {
  const t = createResponsesToAnthropicStreamTranslator(modelId, opts)
  const out: Array<ServerSentEventMessage> = []
  for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return out
}

/** Drive the translator AND return the terminal meta (getMeta reads the translator's own running state). */
function renderAllWithMeta(events: Array<ServerSentEventMessage>, modelId = "gpt-5.5") {
  const t = createResponsesToAnthropicStreamTranslator(modelId)
  const out: Array<ServerSentEventMessage> = []
  for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return { frames: out, meta: t.getMeta() }
}

/** Parse a frame's JSON data. */
function data(frame: ServerSentEventMessage): Record<string, unknown> {
  return JSON.parse(frame.data ?? "{}") as Record<string, unknown>
}

// ── the Responses SSE event shapes upstream emits ─────────────────────────────

function created(id = "resp_1", model = "gpt-5.5"): ServerSentEventMessage {
  return rEvent({ type: "response.created", response: { id, model } })
}
function textDelta(text: string, outputIndex = 0): ServerSentEventMessage {
  return rEvent({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: text })
}
function reasoningAdded(outputIndex: number, encrypted?: string): ServerSentEventMessage {
  return rEvent({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "reasoning", id: "r1", summary: [], ...(encrypted !== undefined && { encrypted_content: encrypted }) },
  })
}
function reasoningSummaryDelta(text: string, outputIndex: number): ServerSentEventMessage {
  return rEvent({ type: "response.reasoning_summary_text.delta", item_id: "r1", output_index: outputIndex, summary_index: 0, delta: text })
}
function reasoningDone(outputIndex: number, encrypted: string): ServerSentEventMessage {
  return rEvent({
    type: "response.output_item.done",
    output_index: outputIndex,
    item: { type: "reasoning", id: "r1", summary: [], encrypted_content: encrypted },
  })
}
function functionCallAdded(outputIndex: number, callId: string, name: string): ServerSentEventMessage {
  return rEvent({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "function_call", id: `fc_${outputIndex}`, call_id: callId, name, arguments: "", status: "in_progress" },
  })
}
function functionCallArgsDelta(outputIndex: number, delta: string): ServerSentEventMessage {
  return rEvent({ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: `fc_${outputIndex}`, delta })
}
function webSearchCallDone(outputIndex: number, query: string, status = "completed"): ServerSentEventMessage {
  return rEvent({
    type: "response.output_item.done",
    output_index: outputIndex,
    item: { type: "web_search_call", id: `ws_${outputIndex}`, status, action: { type: "search", query } },
  })
}
function completed(
  usage: Record<string, unknown>,
  status: "completed" | "incomplete" = "completed",
  incompleteDetails?: { reason: string },
  id = "resp_1",
  model = "gpt-5.5",
): ServerSentEventMessage {
  return rEvent({
    type: "response.completed",
    response: { id, model, status, usage, ...(incompleteDetails !== undefined && { incomplete_details: incompleteDetails }) },
  })
}

describe("responses-to-anthropic-stream — text + tool_use block indices (native output_index, never CC-remapped)", () => {
  test("text-then-tool: text at index 0, tool at monotone index 1", () => {
    const frames = renderAll([
      created(),
      textDelta("Let me use a tool. ", 0),
      functionCallAdded(1, "call_a", "get_weather"),
      functionCallArgsDelta(1, '{"city":"SF"}'),
      completed({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
    ])
    assertAnthropicEventLineInvariant(frames)

    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => f.data && data(f).index)).toEqual([0, 1])
    expect(data(starts[0]).content_block).toMatchObject({ type: "text" })
    expect(data(starts[1]).content_block).toMatchObject({ type: "tool_use", id: "call_a", name: "get_weather" })

    const stops = frames.filter((f) => data(f).type === "content_block_stop").map((f) => data(f).index)
    expect(stops).toEqual([0, 1])
  })

  test("leading tool (no text) → tool lands at index 0 (lazy allocator, arrival order)", () => {
    const frames = renderAll([
      created(),
      functionCallAdded(0, "call_only", "Bash"),
      functionCallArgsDelta(0, "{}"),
      completed({ input_tokens: 3, output_tokens: 1, total_tokens: 4 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => data(f).index)).toEqual([0])
    expect(data(starts[0]).content_block).toMatchObject({ type: "tool_use", id: "call_only" })
  })

  test("tool_calls forces stop_reason=tool_use regardless of terminal status", () => {
    const { meta } = renderAllWithMeta([
      created(),
      functionCallAdded(0, "call_a", "f"),
      functionCallArgsDelta(0, "{}"),
      completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ])
    expect(meta.stopReason).toBe("tool_use")
  })

  test("interleaved (non-sequential) tool args defensively reopen the target block (never crash on an out-of-order upstream)", () => {
    const frames = renderAll([
      created(),
      functionCallAdded(0, "call_a", "toolA"),
      functionCallAdded(1, "call_b", "toolB"),
      // Args for tool 0 arrive AFTER tool 1's block_start already fired — defensive reopen path.
      functionCallArgsDelta(0, '{"x":1}'),
      functionCallArgsDelta(1, '{"y":2}'),
      completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ])
    assertAnthropicEventLineInvariant(frames)
    const jsonDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "input_json_delta")
    expect(jsonDeltas.length).toBe(2)
  })

  test("NEGATIVE SAMPLE (proves output_index is NOT used verbatim as the Anthropic block index): a sparse/large native output_index (e.g. 7, after several unmodeled prior items) still allocates a small monotone Anthropic index — a naive `anthropicIndex = event.output_index` bug would emit an ILLEGAL block_start at index 7 (Anthropic requires 0,1,2,… with no gaps)", () => {
    const frames = renderAll([
      created(),
      textDelta("first", 0),
      functionCallAdded(7, "call_sparse", "f"),
      functionCallArgsDelta(7, "{}"),
      completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    // Anthropic block indices are the ALLOCATOR's own monotone counter (0, 1) — NEVER the raw
    // Responses output_index (0, 7) — this is what distinguishes "keyed allocation" from "verbatim passthrough".
    expect(starts.map((f) => data(f).index)).toEqual([0, 1])
    expect(data(starts[1]).content_block).toMatchObject({ type: "tool_use", id: "call_sparse" })
  })
})

describe("responses-to-anthropic-stream — structured-output refusal (never-swallow)", () => {
  function refusalDelta(text: string, outputIndex = 0): ServerSentEventMessage {
    return rEvent({ type: "response.refusal.delta", output_index: outputIndex, content_index: 0, delta: text })
  }

  test("refusal delta is forwarded as a text block (mirrors the non-streaming bridge's refusal passthrough)", () => {
    const frames = renderAll([created(), refusalDelta("I cannot help with that"), completed({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.length).toBe(1)
    expect(data(starts[0]).content_block).toMatchObject({ type: "text" })
    const textDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "text_delta")
    expect(textDeltas.map((f) => (data(f).delta as { text: string }).text).join("")).toBe("I cannot help with that")
  })
})

describe("responses-to-anthropic-stream — web_search_call → readable text (R-NO-REVIVE, RFC §5.1/§9, Phase 6 subtask Q)", () => {
  test("a web_search_call arrives whole on .done (no intermediate deltas) and renders as a complete, self-closed text block", () => {
    const frames = renderAll([
      created(),
      webSearchCallDone(0, "official Bun runtime website"),
      textDelta("https://bun.com/", 1),
      completed({ input_tokens: 3, output_tokens: 2, total_tokens: 5 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.length).toBe(2) // web_search text block + the answer text block
    expect(data(starts[0]).content_block).toMatchObject({ type: "text" })
    const stops = frames.filter((f) => data(f).type === "content_block_stop")
    expect(stops.map((f) => data(f).index)).toEqual([0, 1])
    const textDelta_ = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "text_delta")
    expect(textDelta_ && (data(textDelta_).delta as { text: string }).text).toBe('[web_search: "official Bun runtime website"] (id: ws_0, status: completed)')
  })

  test("an incomplete web_search_call without action emits readable unknown-query text instead of throwing", () => {
    const incomplete = rEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "web_search_call", id: "ws_incomplete", status: "incomplete" } satisfies ResponsesOutputItem,
    })
    const frames = renderAll([created(), incomplete, completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, "incomplete")])
    const textDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "text_delta")
    expect(textDeltas.map((f) => (data(f).delta as { text: string }).text)).toEqual(['[web_search: "(unknown query)"] (id: ws_incomplete, status: incomplete)'])
  })

  test("NEGATIVE SAMPLE (R-NO-REVIVE load-bearing assertion): the streamed wire NEVER contains a web_search_tool_result type or any encrypted_content for this item", () => {
    const frames = renderAll([created(), webSearchCallDone(0, "query"), completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })])
    const wire = frames.map((f) => f.data ?? "").join("")
    expect(wire).not.toContain("web_search_tool_result")
    expect(wire).not.toContain("encrypted_content")
  })

  test("NEGATIVE SAMPLE (adversarial, R-NO-REVIVE): a streamed web_search_call carrying a PLANTED encrypted_content is NOT smuggled through (不发明 → 不搬运)", () => {
    const adversarial = rEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "web_search_call", id: "ws_adv", status: "completed", action: { type: "search", query: "q", encrypted_content: "FAKE_SIGNED_BLOB" } },
    })
    const frames = renderAll([created(), adversarial, completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })])
    const wire = frames.map((f) => f.data ?? "").join("")
    expect(wire).not.toContain("web_search_tool_result")
    expect(wire).not.toContain("FAKE_SIGNED_BLOB")
    expect(wire).not.toContain("encrypted_content")
  })

  test("web_search_call sandwiched between text blocks doesn't corrupt block-index allocation (each gets its own monotone index)", () => {
    const frames = renderAll([
      created(),
      textDelta("before", 0),
      webSearchCallDone(1, "query"),
      textDelta("after", 2),
      completed({ input_tokens: 3, output_tokens: 3, total_tokens: 6 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => data(f).index)).toEqual([0, 1, 2])
  })
})

describe("responses-to-anthropic-stream — reasoning → synthetic thinking block (IMPROVEMENT ZONE, .done capture fix)", () => {
  const PREFIX = "copilot-api:synthetic-reasoning:v1:"

  test("reasoning summary deltas render a thinking block FIRST (thinking-first), text follows", () => {
    const frames = renderAll([
      created(),
      reasoningAdded(0),
      reasoningSummaryDelta("internal ", 0),
      reasoningSummaryDelta("thoughts", 0),
      textDelta("visible", 1),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
    ])
    assertAnthropicEventLineInvariant(frames)
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => data(f).index)).toEqual([0, 1])
    expect(data(starts[0]).content_block).toMatchObject({ type: "thinking" })
    expect(data(starts[1]).content_block).toMatchObject({ type: "text" })
  })

  test("reasoning summary delta with NO preceding .added event still opens its own thinking block (defensive lazy-open)", () => {
    const frames = renderAll([
      created(),
      reasoningSummaryDelta("thoughts without added", 0),
      textDelta("answer", 1),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => (data(f).content_block as { type: string }).type)).toEqual(["thinking", "text"])
  })

  test("thinking_delta carries the summary text; a signature_delta with the SENTINEL precedes the block stop", () => {
    const frames = renderAll([
      created(),
      reasoningAdded(0),
      reasoningSummaryDelta("step 1 ", 0),
      reasoningSummaryDelta("step 2", 0),
      textDelta("answer", 1),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
    ])
    const thinkingDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "thinking_delta")
    expect(thinkingDeltas.map((f) => (data(f).delta as { thinking: string }).thinking).join("")).toBe("step 1 step 2")

    const seq = frames
      .map((f) => {
        const d = data(f)
        if (d.type === "content_block_delta" && (d.delta as { type: string }).type === "signature_delta") return `sig@${d.index as number}`
        if (d.type === "content_block_stop") return `stop@${d.index as number}`
        return null
      })
      .filter(Boolean)
    expect(seq.indexOf("sig@0")).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf("sig@0")).toBeLessThan(seq.indexOf("stop@0"))

    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    expect((data(sig).delta as { signature: string }).signature).toBe(PREFIX)
  })

  test("encrypted_content is captured ONLY from .done, NEVER .added (Phase 0 FINDINGS: added is a mid-state blob, done is authoritative)", async () => {
    const addedBlob = "MID-STATE-added-blob"
    const doneBlob = "AUTHORITATIVE-done-blob"
    const frames = renderAll([
      created(),
      reasoningAdded(0, addedBlob),
      reasoningSummaryDelta("thinking", 0),
      reasoningDone(0, doneBlob),
      textDelta("answer", 1),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
    ])
    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    const signature = (data(sig).delta as { signature: string }).signature
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    // The DONE blob wins — never the ADDED (mid-state) blob (the recorded defect this file must NOT inherit).
    expect(extractEncryptedReasoning(signature)).toBe(doneBlob)
  })

  test("no .done event arrives (stream truncated mid-reasoning) → signature falls back to bare prefix (no payload), never the mid-state .added blob", async () => {
    const addedBlob = "MID-STATE-added-blob"
    const frames = renderAll([
      created(),
      reasoningAdded(0, addedBlob),
      reasoningSummaryDelta("thinking", 0),
      textDelta("answer", 1),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
    ])
    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    const signature = (data(sig).delta as { signature: string }).signature
    expect(signature).toBe(PREFIX)
  })

  test("SDK ORACLE: a reasoning+tool_use+text stream accumulates a well-formed message via the REAL @anthropic-ai/sdk", async () => {
    const frames = renderAll([
      created(),
      reasoningAdded(0, "mid"),
      reasoningSummaryDelta("Let me think. ", 0),
      reasoningSummaryDelta("Done.", 0),
      reasoningDone(0, "final-encrypted-blob"),
      functionCallAdded(1, "call_x", "get_weather"),
      functionCallArgsDelta(1, '{"city":"SF"}'),
      textDelta("The weather is sunny.", 2),
      completed({ input_tokens: 20, output_tokens: 10, total_tokens: 30 }),
    ])
    assertAnthropicEventLineInvariant(frames)
    const msg = await accumulateAnthropic(frames)
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "text"])
    const thinking = msg.content[0] as { type: "thinking"; thinking: string; signature: string }
    expect(thinking.thinking).toBe("Let me think. Done.")
    expect(thinking.signature.startsWith(PREFIX)).toBe(true)
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    expect(extractEncryptedReasoning(thinking.signature)).toBe("final-encrypted-blob")
    const toolUse = msg.content[1] as { type: "tool_use"; id: string; name: string; input: unknown }
    expect(toolUse).toMatchObject({ type: "tool_use", id: "call_x", name: "get_weather", input: { city: "SF" } })
    expect((msg.content[2] as { type: "text"; text: string }).text).toBe("The weather is sunny.")
    // tool_use present → stop_reason tool_use (mirrors the non-streaming bridge's hasToolCalls override).
    expect(msg.stop_reason).toBe("tool_use")
  })
})

describe("responses-to-anthropic-stream — RFC §4.3 scenario A/B (Phase 5 model_translation wiring)", () => {
  test("scenario B (stripThinkingSignature=true) NEVER embeds encrypted_content into the sentinel — bare-prefix signature only, plaintext still streams", async () => {
    const frames = renderAll(
      [
        created(),
        reasoningAdded(0),
        reasoningSummaryDelta("still shown", 0),
        reasoningDone(0, "SHOULD-NOT-BE-CARRIED"),
        completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
      ],
      "gpt-5.5",
      { stripThinkingSignature: true },
    )
    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    const signature = (data(sig).delta as { signature: string }).signature
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    expect(extractEncryptedReasoning(signature)).toBeUndefined()
    const thinkingDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "thinking_delta")
    expect(thinkingDeltas.map((f) => (data(f).delta as { thinking: string }).thinking).join("")).toBe("still shown")
  })

  test("scenario A (default, no opts) DOES embed encrypted_content — the default is full round-trip", async () => {
    const frames = renderAll([
      created(),
      reasoningAdded(0),
      reasoningSummaryDelta("shown", 0),
      reasoningDone(0, "REAL-ENC"),
      completed({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    ])
    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    const signature = (data(sig).delta as { signature: string }).signature
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    expect(extractEncryptedReasoning(signature)).toBe("REAL-ENC")
  })
})

describe("responses-to-anthropic-stream — self-contained terminal meta (usage + stop_reason, no CC accumulator)", () => {
  test("plain text completion → end_turn + net usage", () => {
    const { meta } = renderAllWithMeta([created(), textDelta("hi", 0), completed({ input_tokens: 12, output_tokens: 4, total_tokens: 16 })])
    expect(meta.stopReason).toBe("end_turn")
    expect(meta.usage).toEqual({ input_tokens: 12, output_tokens: 4 })
    expect(meta.contentFiltered).toBe(false)
  })

  test("cached input tokens subtracted (net-of-cache, reused ① from subtask B)", () => {
    const { meta } = renderAllWithMeta([
      created(),
      textDelta("hi", 0),
      completed({ input_tokens: 100, output_tokens: 4, total_tokens: 104, input_tokens_details: { cached_tokens: 30 } }),
    ])
    expect(meta.usage).toEqual({ input_tokens: 70, output_tokens: 4, cache_read_input_tokens: 30 })
  })

  test("MAJOR FIX (was silently dropped by the bare netInputTokens primitive): reasoning_tokens is forwarded onto the terminal usage", () => {
    const { meta } = renderAllWithMeta([
      created(),
      textDelta("hi", 0),
      completed({ input_tokens: 20, output_tokens: 10, total_tokens: 30, output_tokens_details: { reasoning_tokens: 6 } }),
    ])
    expect(meta.usage).toEqual({ input_tokens: 20, output_tokens: 10, output_tokens_details: { reasoning_tokens: 6 } })
  })

  test("incomplete + max_output_tokens → max_tokens stop_reason", () => {
    const { meta } = renderAllWithMeta([
      created(),
      textDelta("hi", 0),
      completed({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }, "incomplete", { reason: "max_output_tokens" }),
    ])
    expect(meta.stopReason).toBe("max_tokens")
    expect(meta.contentFiltered).toBe(false)
  })

  test("incomplete + content_filter → end_turn (N3 — NOT refusal, matches the non-streaming bridge's corrected mapping) + contentFiltered flag", () => {
    const { meta } = renderAllWithMeta([
      created(),
      textDelta("", 0),
      completed({ input_tokens: 5, output_tokens: 0, total_tokens: 5 }, "incomplete", { reason: "content_filter" }),
    ])
    expect(meta.stopReason).toBe("end_turn")
    expect(meta.contentFiltered).toBe(true)
  })

  test("no terminal lifecycle event arrived (truncated stream) → stopReason undefined (the truncation signal, mirrors the CC-leg's finish_reason-absence convention)", () => {
    const { meta } = renderAllWithMeta([created(), textDelta("partial", 0)])
    expect(meta.stopReason).toBeUndefined()
  })
})

describe("responses-to-anthropic-stream — unparseable / malformed frames (never-swallow, never-throw for the translator itself)", () => {
  test("an unparseable JSON frame is skipped, not thrown", () => {
    const t = createResponsesToAnthropicStreamTranslator("gpt-5.5")
    expect(() => t.renderFrame({ data: "not json {{{", event: "message" })).not.toThrow()
  })

  test("[DONE] / empty-data frames are no-ops", () => {
    const t = createResponsesToAnthropicStreamTranslator("gpt-5.5")
    expect(t.renderFrame({ data: "[DONE]", event: "message" })).toEqual([])
    expect(t.renderFrame({ data: "", event: "message" })).toEqual([])
  })

  test("response.failed throws (propagates to the caller — mirrors the CC-leg + Responses→CC translator convention)", () => {
    const t = createResponsesToAnthropicStreamTranslator("gpt-5.5")
    expect(() => t.renderFrame(rEvent({ type: "response.failed", response: { error: { message: "boom" } } }))).toThrow(/boom/)
  })

  test("a terminal error event throws (mirrors the CC-leg convention)", () => {
    const t = createResponsesToAnthropicStreamTranslator("gpt-5.5")
    expect(() => t.renderFrame(rEvent({ type: "error", message: "upstream overloaded" }))).toThrow(/upstream overloaded/)
  })

  test("flush is idempotent (a second call yields no additional frames)", () => {
    const t = createResponsesToAnthropicStreamTranslator("gpt-5.5")
    for (const s of t.renderFrame(created())) void s
    const first = t.flush()
    const second = t.flush()
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual([])
  })
})
