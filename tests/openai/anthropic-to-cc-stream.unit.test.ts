/**
 * T5.1 — Anthropic → CC STREAMING response translator (REVERSE leg, byte-critical).
 *
 * Two oracles:
 *   1. SELF golden (`renderAll`) — locks the exact CC frame sequence: lazy role chunk, text→content,
 *      tool_use→tool_calls with an INDEPENDENT CC tool index (W1 inverse), the drop/swallow rules per
 *      the §8.2 exhaustive frame table (thinking / server_tool_use / ping / their deltas), the inline
 *      finish + usage chunks on message_delta, and the truncation signal (no message_delta → finishReason
 *      undefined).
 *   2. INDEPENDENT CC consumer oracle (`accumulateOpenAIStreamEvent`) — feeds the synthesized CC frames
 *      into the REAL CC stream accumulator (the exact one the pump + history use) and asserts the rebuilt
 *      completion (content / tool_calls / finish / usage) survives. A self-consistent golden CANNOT catch
 *      a consumer-side loss (a phantom tool_call, a dropped delta) — only the real accumulator can. A
 *      POSITIVE CONTROL (a sabotaged translator variant) proves the oracle is not a no-op.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

import { accumulateOpenAIStreamEvent, createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
import { createAnthropicToCcStreamTranslator } from "~/lib/openai/translate/anthropic-to-cc-stream"

// ── helpers ──────────────────────────────────────────────────────────────────

/** An Anthropic SSE event frame (the shape the upstream sends). */
function aev(obj: unknown): ServerSentEventMessage {
  return { data: JSON.stringify(obj), event: (obj as { type: string }).type }
}

/** Drive the translator over a list of Anthropic events + flush; return the ordered CC frames. */
function renderAll(events: Array<ServerSentEventMessage>, modelId = "claude-x"): Array<ServerSentEventMessage> {
  const t = createAnthropicToCcStreamTranslator(modelId)
  const out: Array<ServerSentEventMessage> = []
  for (const e of events) for (const s of t.renderFrame(e)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return out
}

/** Parse a frame's JSON data. */
function data(frame: ServerSentEventMessage): Record<string, unknown> {
  return JSON.parse(frame.data ?? "{}") as Record<string, unknown>
}

/** The first choice's delta of a CC chunk frame. */
function delta(frame: ServerSentEventMessage): Record<string, unknown> {
  const choices = data(frame).choices as Array<{ delta?: Record<string, unknown> }> | undefined
  return choices?.[0]?.delta ?? {}
}

/**
 * INDEPENDENT ORACLE: rebuild the CC completion from the synthesized frames via the REAL CC stream
 * accumulator (the pump + history feed the exact same function). A dropped content delta, a phantom
 * tool_call, or a mis-indexed tool would corrupt the rebuilt shape here — the self golden can't see that.
 */
function ccAccumulate(frames: Array<ServerSentEventMessage>): ReturnType<typeof createOpenAIStreamAccumulator> {
  const acc = createOpenAIStreamAccumulator()
  for (const f of frames) {
    if (!f.data || f.data === "[DONE]" || f.event === "error") continue
    accumulateOpenAIStreamEvent(JSON.parse(f.data) as ChatCompletionChunk, acc)
  }
  return acc
}

/** Reconstruct the ordered tool calls from the accumulator's index-keyed map (id + name + joined args). */
function toolCallsOf(acc: ReturnType<typeof createOpenAIStreamAccumulator>): Array<{ id: string; name: string; arguments: string }> {
  return [...acc.toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, name: v.name, arguments: v.argumentParts.join("") }))
}

// ── the Anthropic frame classes ───────────────────────────────────────────────

function messageStart(usage: Record<string, number>): ServerSentEventMessage {
  return aev({ type: "message_start", message: { id: "msg_rev", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, stop_sequence: null, usage } })
}
function blockStart(index: number, block: Record<string, unknown>): ServerSentEventMessage {
  return aev({ type: "content_block_start", index, content_block: block })
}
function textDelta(index: number, text: string): ServerSentEventMessage {
  return aev({ type: "content_block_delta", index, delta: { type: "text_delta", text } })
}
function jsonDelta(index: number, partial: string): ServerSentEventMessage {
  return aev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } })
}
function blockStop(index: number): ServerSentEventMessage {
  return aev({ type: "content_block_stop", index })
}
function messageDelta(stopReason: string, usage: Record<string, number>): ServerSentEventMessage {
  return aev({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage })
}
const messageStopEvent = aev({ type: "message_stop" })
const pingEvent = aev({ type: "ping" })

describe("anthropic-to-cc-stream — inverse fold + lazy role chunk", () => {
  test("text-only turn → one role chunk, content deltas, finish=stop (inverse of the multi-choices split)", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 10, output_tokens: 0 }),
      blockStart(0, { type: "text", text: "" }),
      textDelta(0, "Hello"),
      textDelta(0, " world"),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 3 }),
      messageStopEvent,
    ])
    // The FIRST chunk carries the role delta (CC convention); message_start emits no chunk.
    expect(delta(frames[0])).toEqual({ role: "assistant" })
    // Text folds into delta.content on choices[0] (never split into multiple choices).
    const contents = frames.map((f) => delta(f).content).filter((c) => typeof c === "string")
    expect(contents).toEqual(["Hello", " world"])
    // Independent CC oracle: the rebuilt completion has the concatenated text + finish=stop.
    const acc = ccAccumulate(frames)
    expect(acc.rawContent).toBe("Hello world")
    expect(acc.finishReason).toBe("stop")
  })

  test("text + two tool_use blocks fold into ONE choices[0] stream; tool indices are INDEPENDENT of the text block", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 50, output_tokens: 0 }),
      blockStart(0, { type: "text", text: "" }),
      textDelta(0, "Let me help."),
      blockStop(0),
      blockStart(1, { type: "tool_use", id: "toolu_a", name: "Read", input: {} }),
      jsonDelta(1, '{"path":'),
      jsonDelta(1, '"/etc/hosts"}'),
      blockStop(1),
      blockStart(2, { type: "tool_use", id: "toolu_b", name: "Write", input: {} }),
      jsonDelta(2, '{"path":"/tmp/x"}'),
      blockStop(2),
      messageDelta("tool_use", { output_tokens: 12 }),
      messageStopEvent,
    ])
    const acc = ccAccumulate(frames)
    // Anthropic text block @0 + tool blocks @1/@2 → CC tool indices 0 and 1 (text does NOT occupy a tool index).
    const calls = toolCallsOf(acc)
    expect(acc.toolCallMap.has(0)).toBe(true)
    expect(acc.toolCallMap.has(1)).toBe(true)
    expect(calls).toEqual([
      { id: "toolu_a", name: "Read", arguments: '{"path":"/etc/hosts"}' },
      { id: "toolu_b", name: "Write", arguments: '{"path":"/tmp/x"}' },
    ])
    expect(acc.rawContent).toBe("Let me help.")
    // tool_use stop_reason → CC tool_calls finish.
    expect(acc.finishReason).toBe("tool_calls")
  })

  test("tool-only turn (no leading text) → tool lands at CC index 0", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 3, output_tokens: 0 }),
      blockStart(0, { type: "tool_use", id: "toolu_only", name: "Bash", input: {} }),
      jsonDelta(0, "{}"),
      blockStop(0),
      messageDelta("tool_use", { output_tokens: 1 }),
      messageStopEvent,
    ])
    const acc = ccAccumulate(frames)
    expect(toolCallsOf(acc)).toEqual([{ id: "toolu_only", name: "Bash", arguments: "{}" }])
  })
})

describe("anthropic-to-cc-stream — §8.2 exhaustive table: drop / swallow", () => {
  test("thinking + redacted_thinking blocks (and their deltas) are DROPPED — no CC frames, no phantom tool_call", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      blockStart(0, { type: "thinking", thinking: "" }),
      aev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal" } }),
      aev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      blockStop(0),
      blockStart(1, { type: "redacted_thinking", data: "xxx" }),
      blockStop(1),
      blockStart(2, { type: "text", text: "" }),
      textDelta(2, "visible"),
      blockStop(2),
      messageDelta("end_turn", { output_tokens: 2 }),
      messageStopEvent,
    ])
    const acc = ccAccumulate(frames)
    // Only the visible text survives; no tool calls; no thinking leaked anywhere.
    expect(acc.rawContent).toBe("visible")
    expect(acc.toolCallMap.size).toBe(0)
    expect(JSON.stringify(frames)).not.toContain("thinking")
    expect(JSON.stringify(frames)).not.toContain("signature")
  })

  test("server_tool_use block + its input_json_delta are SWALLOWED (no phantom CC tool_call / index clash)", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      blockStart(0, { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }),
      jsonDelta(0, '{"query":"x"}'), // MUST be swallowed — else a phantom CC tool_call appears
      blockStop(0),
      blockStart(1, { type: "tool_use", id: "toolu_real", name: "Read", input: {} }),
      jsonDelta(1, '{"path":"/a"}'),
      blockStop(1),
      messageDelta("tool_use", { output_tokens: 4 }),
      messageStopEvent,
    ])
    const acc = ccAccumulate(frames)
    // ONLY the real tool_use survived — the server_tool_use produced no CC tool_call.
    expect(toolCallsOf(acc)).toEqual([{ id: "toolu_real", name: "Read", arguments: '{"path":"/a"}' }])
    expect(JSON.stringify(frames)).not.toContain("web_search")
    expect(JSON.stringify(frames)).not.toContain("srv_1")
  })

  test("ping is swallowed; a mid-stream error becomes a CC error chunk", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      pingEvent,
      blockStart(0, { type: "text", text: "" }),
      textDelta(0, "hi"),
      pingEvent,
      aev({ type: "error", error: { type: "overloaded_error", message: "boom" } }),
    ])
    // ping produced no frame; the error surfaced as a CC error chunk.
    const errFrames = frames.filter((f) => f.event === "error")
    expect(errFrames).toHaveLength(1)
    expect(data(errFrames[0])).toEqual({ error: { message: "boom", type: "overloaded_error" } })
  })
})

describe("anthropic-to-cc-stream — usage gross-up (shared mapUsage, no W-rev under-count) + finish mapping", () => {
  test("net Anthropic input + cache legs → CC prompt_tokens TOTAL (cache re-added); message_delta carries usage", () => {
    const frames = renderAll([
      messageStart({ input_tokens: 70, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }),
      blockStart(0, { type: "text", text: "" }),
      textDelta(0, "x"),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 20 }),
      messageStopEvent,
    ])
    const usageFrame = frames.find((f) => (data(f).usage as unknown) !== undefined)!
    const usage = data(usageFrame).usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
    // NET input 70 + cache_read 30 + cache_creation 10 = 110 prompt_tokens TOTAL (never under-counted — W-rev).
    expect(usage.prompt_tokens).toBe(110)
    expect(usage.completion_tokens).toBe(20)
    expect(usage.total_tokens).toBe(130)
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(30)
    // The CC accumulator picks up the same net-of-cache split.
    const acc = ccAccumulate(frames)
    expect(acc.inputTokens).toBe(110)
    expect(acc.cachedTokens).toBe(30)
    expect(acc.outputTokens).toBe(20)
  })

  test("refusal message_delta reports the category-loss degradation while mapping to content_filter", () => {
    const degradations: Array<unknown> = []
    const t = createAnthropicToCcStreamTranslator("claude-x", (degradation) => degradations.push(degradation))
    const events = [
      messageStart({ input_tokens: 1, output_tokens: 0 }),
      blockStart(0, { type: "text", text: "" }),
      blockStop(0),
      aev({
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      messageStopEvent,
    ]
    for (const event of events) t.renderFrame(event)
    expect(t.getMeta().finishReason).toBe("content_filter")
    expect(degradations).toEqual([{ kind: "refusal-category-dropped", category: "cyber", target: "openai-cc" }])
  })

  test("stop_reason mapping: end_turn→stop, tool_use→tool_calls, max_tokens→length, refusal→content_filter", () => {
    const finishFor = (stopReason: string, withTool = false): unknown => {
      const events = [messageStart({ input_tokens: 1, output_tokens: 0 })]
      if (withTool) events.push(blockStart(0, { type: "tool_use", id: "t", name: "f", input: {} }), jsonDelta(0, "{}"), blockStop(0))
      else events.push(blockStart(0, { type: "text", text: "" }), textDelta(0, "x"), blockStop(0))
      events.push(messageDelta(stopReason, { output_tokens: 1 }), messageStopEvent)
      const acc = ccAccumulate(renderAll(events))
      return acc.finishReason
    }
    expect(finishFor("end_turn")).toBe("stop")
    expect(finishFor("tool_use", true)).toBe("tool_calls")
    expect(finishFor("max_tokens")).toBe("length")
    expect(finishFor("refusal")).toBe("content_filter")
  })

  test("getMeta: finishReason + grossed-up usage + sawMessageStop after a clean stream", () => {
    const t = createAnthropicToCcStreamTranslator("claude-x")
    for (const e of [messageStart({ input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 10 }), blockStart(0, { type: "text", text: "" }), textDelta(0, "hi"), blockStop(0), messageDelta("end_turn", { output_tokens: 5 }), messageStopEvent]) {
      for (const _ of t.renderFrame(e)) void _
    }
    const meta = t.getMeta()
    expect(meta.finishReason).toBe("stop")
    expect(meta.usage?.prompt_tokens).toBe(50) // 40 net + 10 cache_read
    expect(meta.usage?.completion_tokens).toBe(5)
    expect(meta.sawMessageStop).toBe(true)
  })

  test("TRUNCATION signal (F2): a stream that ends WITHOUT message_delta → getMeta().finishReason undefined + sawMessageStop false", () => {
    const t = createAnthropicToCcStreamTranslator("claude-x")
    for (const e of [messageStart({ input_tokens: 5, output_tokens: 0 }), blockStart(0, { type: "text", text: "" }), textDelta(0, "partial")]) {
      for (const _ of t.renderFrame(e)) void _
    }
    expect(t.getMeta().finishReason).toBeUndefined()
    expect(t.getMeta().sawMessageStop).toBe(false)
  })
})

describe("anthropic-to-cc-stream — INDEPENDENT consumer oracle is not a no-op (positive control)", () => {
  test("POSITIVE CONTROL: an UNCONDITIONAL input_json_delta map (the bug) DOES spawn a phantom CC tool_call the oracle catches", () => {
    // Simulate the bug the swallow rule prevents: emit a CC tool_call args chunk for a server_tool_use
    // block's input_json_delta (index 0), as a naive translator would. The real accumulator then rebuilds
    // a PHANTOM tool_call at index 0 — proving the oracle genuinely detects the loss the swallow avoids.
    const buggyFrames: Array<ServerSentEventMessage> = [
      { data: JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "claude-x", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }), event: "message" },
      // phantom: a tool_call for what was really a server_tool_use
      { data: JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "claude-x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "srv_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }, finish_reason: null }] }), event: "message" },
    ]
    const acc = ccAccumulate(buggyFrames)
    expect(acc.toolCallMap.size).toBe(1) // the phantom exists in the buggy variant
    expect(acc.toolCallMap.get(0)?.name).toBe("web_search")

    // Contrast: the REAL translator swallows it — the oracle sees ZERO tool calls.
    const realFrames = renderAll([
      messageStart({ input_tokens: 5, output_tokens: 0 }),
      blockStart(0, { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }),
      jsonDelta(0, '{"query":"x"}'),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 1 }),
      messageStopEvent,
    ])
    expect(ccAccumulate(realFrames).toolCallMap.size).toBe(0)
  })
})
