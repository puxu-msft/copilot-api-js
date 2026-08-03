/**
 * T4.2 regression — the translate-leg stream-end flush frames MUST pass through the same live-reconcile
 * as the driver-loop frames (adversarial-review CRITICAL: under `empty_text` anchor the live loop remaps
 * real blocks +1, so the translator's terminal `content_block_stop` — emitted only at flush, not on the
 * finish_reason chunk — must ALSO be +1-remapped, or it lands at the un-remapped index and dangles).
 *
 * This drives the REAL forward stream translator (via the anthropic codec) through the SAME
 * `makeReconcilingSink(sink, anchorState, hooks)` the pump now uses for BOTH the driver loop AND the
 * flush, with an injected `empty_text` anchor (anchorBlockOpen), and asserts the wire block-index
 * structure is BALANCED — every `content_block_start@i` has a matching `content_block_stop@i`, the anchor
 * occupies index 0, and the real block is shifted to index 1.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  AnchorState,
  ClientFrame,
} from "~/lib/pipeline/types"

import {
  //
  anchorStopFrame,
  remapAnthropicBlockIndex,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { ENDPOINT } from "~/lib/models/endpoint"
import { makeArraySink } from "~/lib/pipeline/client-sink"

/** A CC SSE chunk (the upstream shape the @cc translate leg receives). */
const ccChunk = (obj: unknown): { data: string; event: string } => ({ data: JSON.stringify(obj), event: "message" })

/** The ReconcileHooks the live reconcile needs (mirrors buildAnthropicAnchorHooks). */
const reconcileHooks = {
  isContentBlockStart: (fr: { data?: string }) => {
    try {
      return (JSON.parse(fr.data ?? "{}") as { type?: unknown }).type === "content_block_start"
    } catch {
      return false
    }
  },
  isMessageStart: (f: ClientFrame): boolean => {
    if (typeof f.data !== "string") return false
    try {
      return (JSON.parse(f.data) as { type?: unknown }).type === "message_start"
    } catch {
      return false
    }
  },
  stopFrame: anchorStopFrame,
  remap: remapAnthropicBlockIndex,
}

function translateLegEnv(): RequestEnvelope {
  return {
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,
    body: { model: "claude-x" },
    model: { id: "claude-x" },
    ctx: { recordFeature: () => {} },
  } as unknown as RequestEnvelope
}

describe("translate-leg flush frames + live reconcile (empty_text anchor +1 remap)", () => {
  test("flush's terminal content_block_stop is +1-remapped so the real block is balanced (no dangling block)", async () => {
    const codec = createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    const env = translateLegEnv()

    // Simulate an injected empty_text anchor prelude: message_start + anchor content_block@0 already
    // forwarded, so the live reconcile drops the translator's message_start and shifts real blocks +1.
    const allocator = createGenerationWireIndexAllocator()
    allocator.onAnchorOpen()
    const anchorState: AnchorState = {
      wireState: createGenerationWireState(allocator),
      injected: true,
      messageStartForwarded: true,
      anchorBlockOpen: true,
      anchorClosed: false,
    }
    const { sink, frames } = makeArraySink()
    const clientSink = makeReconcilingSink(sink, anchorState, reconcileHooks)

    // Drive the driver-loop frames (renderResponse) through the reconciling sink — a single text block.
    const loopFrames = [
      ...(codec.renderResponse(
        ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
        env,
      ) as Array<ClientFrame>),
      ...(codec.renderResponse(
        ccChunk({
          id: "msg_x",
          model: "claude-x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        env,
      ) as Array<ClientFrame>),
    ]
    for (const f of loopFrames) await clientSink.write(f)
    // Stream-end flush — the FIX: route through the SAME reconciling sink (not the raw sink).
    for (const f of codec.flushResponse(env)) await clientSink.write(f)

    // Collect the (index-bearing) block frames from the wire.
    const blocks = frames
      .map((f) => JSON.parse(f.data ?? "{}") as { type?: string; index?: number })
      .filter((o) => o.type === "content_block_start" || o.type === "content_block_stop")

    // This unit uses an array sink, so owner-side anchor close is intentionally absent. It still proves
    // the loop start and flush stop share the same bridge remap; production owner-close coverage lives in
    // the delivery-session integration tests.
    const starts = blocks.filter((b) => b.type === "content_block_start")
    const stops = blocks.filter((b) => b.type === "content_block_stop")
    expect(starts.map((s) => s.index)).toEqual([1]) // real text block remapped +1
    expect(stops.map((s) => s.index)).toContain(1) // the flush's content_block_stop, +1-remapped (THE FIX)

    // BALANCE: every real content_block_start@i has a matching content_block_stop@i.
    for (const s of starts) expect(stops.some((x) => x.index === s.index)).toBe(true)

    // message_start dropped (anchor injected one); the terminal message_delta + message_stop survive.
    const types = frames.map((f) => JSON.parse(f.data ?? "{}").type)
    expect(types).not.toContain("message_start")
    expect(types).toContain("message_delta")
    expect(types.at(-1)).toBe("message_stop")
  })

  test("no anchor injected → reconcile is transparent passthrough (flush block-close keeps its index)", async () => {
    const codec = createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    const env = translateLegEnv()
    // Fast path: no stall → no anchor injected.
    const anchorState: AnchorState = {
      wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
      injected: false,
      messageStartForwarded: false,
      anchorBlockOpen: false,
      anchorClosed: false,
    }
    const { sink, frames } = makeArraySink()
    const clientSink = makeReconcilingSink(sink, anchorState, reconcileHooks)

    const loopFrames = [
      ...(codec.renderResponse(
        ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
        env,
      ) as Array<ClientFrame>),
      ...(codec.renderResponse(
        ccChunk({
          id: "msg_x",
          model: "claude-x",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        env,
      ) as Array<ClientFrame>),
    ]
    for (const f of loopFrames) await clientSink.write(f)
    for (const f of codec.flushResponse(env)) await clientSink.write(f)

    const blocks = frames
      .map((f) => JSON.parse(f.data ?? "{}") as { type?: string; index?: number })
      .filter((o) => o.type === "content_block_start" || o.type === "content_block_stop")
    // No remap: real block stays at index 0, start@0 + stop@0 balanced, message_start survives.
    expect(blocks.filter((b) => b.type === "content_block_start").map((b) => b.index)).toEqual([0])
    expect(blocks.filter((b) => b.type === "content_block_stop").map((b) => b.index)).toEqual([0])
    expect(frames.map((f) => JSON.parse(f.data ?? "{}").type)).toContain("message_start")
  })
})
