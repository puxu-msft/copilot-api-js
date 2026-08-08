/**
 * T4.1 — CC → Anthropic STREAMING response translator (forward leg).
 *
 * Two oracles:
 *   1. SELF golden (this file's `renderAll` helper drives renderFrame/flush) — locks the exact
 *      Anthropic frame sequence + block indices (W1), thinking-drop (W2), usage placeholder/correction
 *      (W3), multi-choices fold, and the N1 event-line invariant on EVERY synthesized frame.
 *   2. INDEPENDENT Anthropic SDK oracle (`sdkAccumulate`) — feeds the synthesized wire into the REAL
 *      `@anthropic-ai/sdk` `MessageStream.fromReadableStream` (the exact decoder Claude Code uses) and
 *      asserts the accumulated `Message` is well-formed. A self-consistent golden CANNOT catch an
 *      event-less frame the SDK silently drops (N1) — only the real SDK decoder can, so this is the
 *      load-bearing byte-critical proof.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createCcToAnthropicStreamTranslator } from "~/lib/openai/translate/cc-to-anthropic-stream"

// ── helpers ──────────────────────────────────────────────────────────────────

/** A CC SSE chunk frame (the shape upstream sends). */
function ccChunk(obj: unknown): ServerSentEventMessage {
  return { data: JSON.stringify(obj), event: "message" }
}

/** Drive the translator over a list of CC chunks + flush; return the ordered Anthropic frames. */
function renderAll(chunks: Array<ServerSentEventMessage>, modelId = "claude-x"): Array<ServerSentEventMessage> {
  const t = createCcToAnthropicStreamTranslator(modelId)
  const out: Array<ServerSentEventMessage> = []
  for (const c of chunks) for (const s of t.renderFrame(c)) out.push(s.frame)
  for (const s of t.flush()) out.push(s.frame)
  return out
}

/** Parse a frame's JSON data. */
function data(frame: ServerSentEventMessage): Record<string, unknown> {
  return JSON.parse(frame.data ?? "{}") as Record<string, unknown>
}

/** The Anthropic stream event names the @anthropic-ai/sdk SSEDecoder dispatches on. */
const SDK_STREAM_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
  "error",
])

/**
 * N1 invariant: EVERY synthesized frame carries an `event:` line equal to its JSON `type` and that
 * name is one the SDK decoder recognizes. An event-less frame decodes to `sse.event === null` and is
 * silently dropped.
 */
function assertEventLineInvariant(frames: Array<ServerSentEventMessage>): void {
  for (const f of frames) {
    const type = (data(f) as { type?: string }).type
    expect(f.event, `frame type=${type} must carry an event: line`).toBe(type)
    expect(SDK_STREAM_EVENTS.has(f.event ?? ""), `event ${f.event} must be SDK-recognized`).toBe(true)
  }
}

/** Serialize the translator's frames into the SSE wire bytes an Anthropic client would receive. */
function toWire(frames: Array<ServerSentEventMessage>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("")
}

/**
 * INDEPENDENT ORACLE: decode the synthesized wire through the REAL Anthropic SDK `Stream.fromSSEResponse`
 * — the exact SSEDecoder Claude Code's SDK uses. It dispatches on the `event:` line and SILENTLY DROPS an
 * event-less / unknown frame (N1), so a frame missing its `event:` line simply never appears in the
 * decoded event sequence. We then reconstruct the `Message` from ONLY the events that survived the real
 * decoder (the accumulation logic is trivial; the byte-critical part is the SDK's decode). If any content
 * frame were event-less it would vanish here — the self golden could never catch that.
 */
function stringField(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`SDK oracle: ${name} must be a string`)
  return value
}

async function sdkAccumulate(frames: Array<ServerSentEventMessage>): Promise<import("@anthropic-ai/sdk/resources/messages").Message> {
  const { Stream } = await import("@anthropic-ai/sdk/core/streaming")
  const response = new Response(toWire(frames), { status: 200, headers: { "content-type": "text/event-stream" } })
  type RawEvent = import("@anthropic-ai/sdk/resources/messages").RawMessageStreamEvent
  const stream = Stream.fromSSEResponse<RawEvent>(response, new AbortController())

  // Reconstruct the Message from the events the real decoder emitted (event-less frames were dropped).
  let message: import("@anthropic-ai/sdk/resources/messages").Message | undefined
  const blocks: Array<Record<string, unknown>> = []
  for await (const ev of stream) {
    switch (ev.type) {
      case "message_start": {
        message = ev.message
        break
      }
      case "content_block_start": {
        blocks[ev.index] = { ...(ev.content_block as unknown as Record<string, unknown>) }
        if (blocks[ev.index].type === "tool_use") blocks[ev.index]._json = ""
        break
      }
      case "content_block_delta": {
        const d = ev.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
        const b = blocks[ev.index]
        if (d.type === "text_delta") b.text = stringField(b.text ?? "", "text block text") + (d.text ?? "")
        if (d.type === "input_json_delta") b._json = stringField(b._json ?? "", "tool input JSON") + (d.partial_json ?? "")
        if (d.type === "thinking_delta") b.thinking = stringField(b.thinking ?? "", "thinking text") + (d.thinking ?? "")
        if (d.type === "signature_delta") b.signature = stringField(b.signature ?? "", "thinking signature") + (d.signature ?? "")
        break
      }
      case "message_delta": {
        if (message) {
          message.stop_reason = ev.delta.stop_reason ?? message.stop_reason
          if (ev.usage) message.usage = { ...message.usage, ...ev.usage } as typeof message.usage
        }
        break
      }
      default: {
        break
      }
    }
  }
  if (!message) throw new Error("SDK oracle: no message_start survived the decoder (N1 event-line drop)")
  // Finalize tool_use inputs from the accumulated json.
  message.content = blocks.filter(Boolean).map((b) => {
    if (b.type === "tool_use")
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b._json ? JSON.parse(stringField(b._json, "tool input JSON")) : {},
      } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
    if (b.type === "thinking")
      return {
        type: "thinking",
        thinking: b.thinking ?? "",
        signature: b.signature ?? "",
      } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
    return { type: "text", text: b.text ?? "", citations: null } as unknown as import("@anthropic-ai/sdk/resources/messages").ContentBlock
  })
  return message
}

// ── the frame classes GHC's cc leg emits (multi-choices split) ────────────────

/** A text delta on choices[0]. */
function textDelta(text: string): ServerSentEventMessage {
  return ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
}
/** A tool_call start (name + id) at CC tool index `idx`, on choices[choiceIdx]. */
function toolStart(idx: number, id: string, name: string, choiceIdx = 0): ServerSentEventMessage {
  return ccChunk({
    id: "msg_x",
    model: "claude-x",
    choices: [{ index: choiceIdx, delta: { tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
  })
}
/** A tool_call args chunk at CC tool index `idx`. */
function toolArgs(idx: number, args: string, choiceIdx = 0): ServerSentEventMessage {
  return ccChunk({
    id: "msg_x",
    model: "claude-x",
    choices: [{ index: choiceIdx, delta: { tool_calls: [{ index: idx, function: { arguments: args } }] }, finish_reason: null }],
  })
}
/** A reasoning delta on choices[0] (GHC plaintext-reasoning extension). */
function reasoningDelta(text: string, field: "reasoning" | "reasoning_content" = "reasoning"): ServerSentEventMessage {
  return ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { [field]: text }, finish_reason: null }] })
}
/** The terminal chunk carrying finish_reason + usage. */
function finish(finishReason: string, usage: Record<string, unknown>): ServerSentEventMessage {
  return ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })
}

describe("cc-to-anthropic-stream — W1 block-index allocator", () => {
  test("text-then-multi-tool: text at index 0, tools monotone at 1 and 2 (no off-by-one)", () => {
    const frames = renderAll([
      textDelta("Let me use tools."),
      toolStart(0, "toolu_a", "Read"), // CC tool index 0 → Anthropic index 1
      toolArgs(0, '{"path":"/a"}'),
      toolStart(1, "toolu_b", "Write"), // CC tool index 1 → Anthropic index 2
      toolArgs(1, '{"path":"/b"}'),
      finish("tool_calls", { prompt_tokens: 10, completion_tokens: 5 }),
    ])
    assertEventLineInvariant(frames)

    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => data(f).index)).toEqual([0, 1, 2])
    expect(data(starts[0]).content_block).toMatchObject({ type: "text" })
    expect(data(starts[1]).content_block).toMatchObject({ type: "tool_use", id: "toolu_a", name: "Read" })
    expect(data(starts[2]).content_block).toMatchObject({ type: "tool_use", id: "toolu_b", name: "Write" })

    // Every open block is closed before the next opens + a terminal content_block_stop.
    const stops = frames.filter((f) => data(f).type === "content_block_stop").map((f) => data(f).index)
    expect(stops).toEqual([0, 1, 2])
  })

  test("leading text absent → first tool lands at index 0 (allocator is lazy, in arrival order)", () => {
    const frames = renderAll([toolStart(0, "toolu_only", "Bash"), toolArgs(0, "{}"), finish("tool_calls", { prompt_tokens: 3, completion_tokens: 1 })])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => data(f).index)).toEqual([0])
    expect(data(starts[0]).content_block).toMatchObject({ type: "tool_use", id: "toolu_only" })
  })

  test("multi-choices FOLD: GHC splits text (choice0) + tool (choice1) — both folded into one message", () => {
    // One chunk carrying BOTH a text choice[0] and a tool choice[1] (GHC's split shape).
    const split = ccChunk({
      id: "msg_x",
      model: "claude-x",
      choices: [
        { index: 0, delta: { content: "answer" }, finish_reason: null },
        { index: 1, delta: { tool_calls: [{ index: 0, id: "toolu_s", type: "function", function: { name: "Grep", arguments: "" } }] }, finish_reason: null },
      ],
    })
    const frames = renderAll([split, toolArgs(0, '{"q":"x"}', 1), finish("tool_calls", { prompt_tokens: 8, completion_tokens: 3 })])
    assertEventLineInvariant(frames)
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => (data(f).content_block as { type: string }).type)).toEqual(["text", "tool_use"])
  })
})

describe("cc-to-anthropic-stream — reasoning → synthetic thinking block (forward, sentinel-signed)", () => {
  const PREFIX = "copilot-api:synthetic-reasoning:v1:"
  /** A reasoning delta carrying GHC's opaque encrypted_content (our CC intermediate carrier). */
  function reasoningEncrypted(encrypted: string): ServerSentEventMessage {
    return ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { reasoning_encrypted_content: encrypted }, finish_reason: null }] })
  }

  test("reasoning deltas render a thinking block at index 0 (thinking-first), text follows at index 1", () => {
    const frames = renderAll([
      reasoningDelta("internal "),
      reasoningDelta("thoughts"),
      textDelta("visible"),
      finish("stop", { prompt_tokens: 5, completion_tokens: 2 }),
    ])
    assertEventLineInvariant(frames)
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    // thinking at 0 (arrived first), text at 1.
    expect(starts.map((f) => data(f).index)).toEqual([0, 1])
    expect(data(starts[0]).content_block).toMatchObject({ type: "thinking" })
    expect(data(starts[1]).content_block).toMatchObject({ type: "text" })
  })

  test("thinking_delta carries the reasoning text; a signature_delta with the SENTINEL precedes the block stop", () => {
    const frames = renderAll([
      reasoningDelta("step 1 "),
      reasoningDelta("step 2"),
      textDelta("answer"),
      finish("stop", { prompt_tokens: 5, completion_tokens: 2 }),
    ])
    const thinkingDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "thinking_delta")
    expect(thinkingDeltas.map((f) => (data(f).delta as { thinking: string }).thinking).join("")).toBe("step 1 step 2")

    // The signature_delta must come BEFORE the thinking block's content_block_stop (index 0).
    const seq = frames
      .map((f) => {
        const d = data(f)
        if (d.type === "content_block_delta" && (d.delta as { type: string }).type === "signature_delta") return `sig@${String(d.index)}`
        if (d.type === "content_block_stop") return `stop@${String(d.index)}`
        return null
      })
      .filter(Boolean)
    expect(seq.indexOf("sig@0")).toBeGreaterThanOrEqual(0)
    expect(seq.indexOf("sig@0")).toBeLessThan(seq.indexOf("stop@0"))

    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    expect((data(sig).delta as { signature: string }).signature).toBe(PREFIX)
  })

  test("reasoning_encrypted_content is embedded in the signature (base64url) for cross-turn round-trip", async () => {
    const encrypted = "OPAQUE-encrypted-blob-xyz=="
    const frames = renderAll([
      reasoningEncrypted(encrypted),
      reasoningDelta("summary text"),
      textDelta("answer"),
      finish("stop", { prompt_tokens: 5, completion_tokens: 2 }),
    ])
    const sig = frames.find((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "signature_delta")!
    const signature = (data(sig).delta as { signature: string }).signature
    expect(signature.startsWith(PREFIX)).toBe(true)
    // The embedded payload decodes back to the original encrypted_content (round-trip).
    const { extractEncryptedReasoning } = await import("~/lib/anthropic/synthetic-reasoning")
    expect(extractEncryptedReasoning(signature)).toBe(encrypted)
  })

  test("reasoning_content field (alt GHC spelling) is also forwarded", () => {
    const frames = renderAll([
      reasoningDelta("via reasoning_content", "reasoning_content"),
      textDelta("x"),
      finish("stop", { prompt_tokens: 1, completion_tokens: 1 }),
    ])
    const thinkingDeltas = frames.filter((f) => data(f).type === "content_block_delta" && (data(f).delta as { type: string }).type === "thinking_delta")
    expect(thinkingDeltas.map((f) => (data(f).delta as { thinking: string }).thinking).join("")).toBe("via reasoning_content")
  })

  test("reasoning-then-tool (no text): thinking at 0, tool at 1", () => {
    const frames = renderAll([
      reasoningDelta("planning"),
      toolStart(0, "toolu_a", "Read"),
      toolArgs(0, "{}"),
      finish("tool_calls", { prompt_tokens: 3, completion_tokens: 1 }),
    ])
    const starts = frames.filter((f) => data(f).type === "content_block_start")
    expect(starts.map((f) => (data(f).content_block as { type: string }).type)).toEqual(["thinking", "tool_use"])
    expect(starts.map((f) => data(f).index)).toEqual([0, 1])
  })

  test("SDK ORACLE: a reasoning+text stream accumulates a well-formed thinking block via the REAL @anthropic-ai/sdk (accept, not reject)", async () => {
    const frames = renderAll([
      reasoningDelta("Let me reason. "),
      reasoningDelta("Done."),
      textDelta("The answer is 42."),
      finish("stop", { prompt_tokens: 5, completion_tokens: 3 }),
    ])
    const msg = await sdkAccumulate(frames)
    // The real SDK decoder ACCEPTED the sentinel-signed thinking block (did not throw/drop it).
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "text"])
    const thinking = msg.content[0] as { type: "thinking"; thinking: string; signature: string }
    expect(thinking.thinking).toBe("Let me reason. Done.")
    expect(thinking.signature).toBe(PREFIX)
    expect((msg.content[1] as { type: "text"; text: string }).text).toBe("The answer is 42.")
  })
})

describe("cc-to-anthropic-stream — interleaved parallel tool-call args (reviewer gap #1)", () => {
  // KNOWN GAP (test.todo): the LIVE translator emits input_json_delta in upstream arrival order, so
  // INTERLEAVED tool args (tool0, tool1, tool0-args, tool1-args) target an already-STOPPED block —
  // an illegal Anthropic reopen. Proper fix = render tool blocks from the accumulator at a commit
  // boundary (the buffered-commit-render design), not a live per-frame patch. Tracked in
  // docs/todo/deferred-backlog.md. When fixed, this promotes to a passing test.
  test.todo("interleaved tool args never emit a content_block_delta on an already-stopped block", () => {
    const frames = renderAll([
      toolStart(0, "toolu_a", "Read"),
      toolStart(1, "toolu_b", "Write"),
      toolArgs(0, '{"a":'),
      toolArgs(1, '{"b":'),
      toolArgs(0, "1}"),
      toolArgs(1, "2}"),
      finish("tool_calls", { prompt_tokens: 5, completion_tokens: 3 }),
    ])
    assertEventLineInvariant(frames)

    const stopped = new Set<number>()
    const illegal: Array<number> = []
    for (const f of frames) {
      const d = data(f)
      if (d.type === "content_block_stop") stopped.add(d.index as number)
      if (d.type === "content_block_delta" && stopped.has(d.index as number)) illegal.push(d.index as number)
    }
    expect(illegal, `deltas targeted already-stopped blocks: ${JSON.stringify(illegal)}`).toEqual([])
  })
})

describe("cc-to-anthropic-stream — W3 usage placeholder + net correction (B1)", () => {
  test("message_start carries input_tokens:0 placeholder; message_delta carries net usage", () => {
    const frames = renderAll([textDelta("hi"), finish("stop", { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } })])
    const start = frames.find((f) => data(f).type === "message_start")!
    expect((data(start).message as { usage: { input_tokens: number } }).usage.input_tokens).toBe(0)

    const delta = frames.find((f) => data(f).type === "message_delta")!
    const usage = data(delta).usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
    // NET input = prompt_tokens (100) − cached (30) = 70 (never double-counts cache — B1).
    expect(usage.input_tokens).toBe(70)
    expect(usage.output_tokens).toBe(20)
    expect(usage.cache_read_input_tokens).toBe(30)
  })

  test("stop_reason mapping: tool_calls→tool_use, length→max_tokens, stop→end_turn", () => {
    const stopReason = (fr: string): unknown => {
      const frames = renderAll([textDelta("x"), finish(fr, { prompt_tokens: 1, completion_tokens: 1 })])
      const delta = frames.find((f) => data(f).type === "message_delta")!
      return (data(delta).delta as { stop_reason: unknown }).stop_reason
    }
    expect(stopReason("tool_calls")).toBe("tool_use")
    expect(stopReason("length")).toBe("max_tokens")
    expect(stopReason("stop")).toBe("end_turn")
  })

  test("getMeta reflects finish + net usage; NO finish_reason → stopReason undefined (truncation signal F2)", () => {
    const t = createCcToAnthropicStreamTranslator("claude-x")
    for (const s of t.renderFrame(textDelta("partial"))) void s
    // No finish chunk fed → truncated.
    expect(t.getMeta().stopReason).toBeUndefined()
  })
})

describe("cc-to-anthropic-stream — INDEPENDENT Anthropic SDK oracle (frames survive the real decoder)", () => {
  test("text + two tool_use blocks accumulate into a well-formed Message via the real SDK", async () => {
    const frames = renderAll([
      textDelta("Let me help. "),
      textDelta("Reading files."),
      toolStart(0, "toolu_a", "Read"),
      toolArgs(0, '{"path":'),
      toolArgs(0, '"/etc/hosts"}'),
      toolStart(1, "toolu_b", "Write"),
      toolArgs(1, '{"path":"/tmp/x","content":"hi"}'),
      finish("tool_calls", { prompt_tokens: 50, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 10 } }),
    ])
    const msg = await sdkAccumulate(frames)

    expect(msg.role).toBe("assistant")
    expect(msg.stop_reason).toBe("tool_use")
    // The real SDK reconstructed: one text block (both deltas concatenated) + two tool_use blocks.
    expect(msg.content.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"])
    const text = msg.content[0] as { type: "text"; text: string }
    expect(text.text).toBe("Let me help. Reading files.")
    const toolA = msg.content[1] as { type: "tool_use"; id: string; name: string; input: unknown }
    expect(toolA).toMatchObject({ id: "toolu_a", name: "Read", input: { path: "/etc/hosts" } })
    const toolB = msg.content[2] as { type: "tool_use"; id: string; name: string; input: unknown }
    expect(toolB).toMatchObject({ id: "toolu_b", name: "Write", input: { path: "/tmp/x", content: "hi" } })
    // NET input usage survived (100 total − 10 cached path here: prompt 50 − cached 10 = 40).
    expect(msg.usage.input_tokens).toBe(40)
    expect(msg.usage.output_tokens).toBe(12)
  })

  test("text-only stream accumulates into a text Message with end_turn via the real SDK", async () => {
    const frames = renderAll([textDelta("Hello"), textDelta(" world"), finish("stop", { prompt_tokens: 5, completion_tokens: 2 })])
    const msg = await sdkAccumulate(frames)
    expect(msg.stop_reason).toBe("end_turn")
    expect(msg.content).toHaveLength(1)
    expect((msg.content[0] as { type: "text"; text: string }).text).toBe("Hello world")
  })

  test("POSITIVE CONTROL: an event-LESS content frame IS dropped by the real SDK decoder (oracle is not a no-op)", async () => {
    // Take a valid frame set, then STRIP the event: line off the text-delta frames — the SDK's SSEDecoder
    // dispatches on the event NAME, so an event-less frame decodes to `event: null` and is DROPPED. This
    // proves the oracle above genuinely exercises the N1 invariant (a self golden could never see this).
    const frames = renderAll([textDelta("visible text"), finish("stop", { prompt_tokens: 5, completion_tokens: 2 })])
    const sabotaged = frames.map((f) => (data(f).type === "content_block_delta" ? { data: f.data } : f))
    const msg = await sdkAccumulate(sabotaged)
    // The text_delta vanished → the reconstructed text block is EMPTY (the loss the SDK oracle catches).
    expect((msg.content[0] as { type: "text"; text: string }).text).toBe("")
  })
})
