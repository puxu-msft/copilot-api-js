import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  //
  AnchorHooks,
  AnchorState,
  ClientSink,
} from "~/lib/pipeline/types"

import { anthropicSseFrame } from "./sse-frame"

/**
 * Reserved index of the synthetic empty-text keepalive ANCHOR block injected in buffered
 * pre-commit (spec 2026-07-08-buffered-keepalive-empty-text-anchor). The anchor occupies
 * index 0; all real content blocks flush at index+1 (see remapAnthropicBlockIndex).
 *
 * NOTE (spec 2026-07-22 §3.3): this fixed "anchor@0, real blocks at +1" model is the COEXIST shape.
 * The SEQUENTIAL-anchor shape (CLI-safe) needs runtime-incrementing indices instead — see
 * {@link createAnchorIndexAllocator}, which supersedes the fixed offset at the sink/driver seam.
 */
export const ANCHOR_INDEX = 0

/**
 * Runtime index allocator for the SEQUENTIAL-anchor wire (spec 2026-07-22 §3.3). Unlike the fixed
 * `ANCHOR_INDEX=0` + `remap(frame, 1)` coexist model, sequential anchors are interspersed among real
 * blocks (wire indices 0=anchor, 1=real, 2=gap-anchor, 3=real, …) with AT MOST ONE block open at a
 * time — so a real block's final wire index is NOT `upstreamIndex + 1` but depends on how many
 * anchors were opened before it. The allocator hands out monotonically increasing wire indices and
 * records the wire index assigned to each real block (in upstream order) so the sink/driver can remap
 * upstream block frames to their sequential wire index via {@link AnchorIndexAllocator.realBlockOffset}.
 */
export interface AnchorIndexAllocator {
  /** Peek the wire index the NEXT anchor block will occupy (pure — advances only on {@link onAnchorOpen}). */
  nextAnchorIndex: () => number
  /** Peek the wire index the NEXT real block will occupy (pure — advances only on {@link onRealBlockOpen}). */
  nextRealIndex: () => number
  /** Commit an anchor block at the current wire index (advances the counter). */
  onAnchorOpen: () => void
  /** Commit a real block at the current wire index (advances the counter; records the mapping). */
  onRealBlockOpen: () => void
  /**
   * The remap offset for the real block that arrived at `upstreamIndex` (upstream's own 0-based block
   * numbering): `wireIndex(upstreamIndex) − upstreamIndex`. Real blocks are opened in upstream order,
   * so `upstreamIndex` is the 0-based position of the real block among all real blocks opened so far.
   */
  realBlockOffset: (upstreamIndex: number) => number
}

export function createAnchorIndexAllocator(): AnchorIndexAllocator {
  let wireCounter = 0
  const realWireIndices: Array<number> = []
  return {
    nextAnchorIndex: () => wireCounter,
    nextRealIndex: () => wireCounter,
    onAnchorOpen: () => void wireCounter++,
    onRealBlockOpen: () => {
      realWireIndices.push(wireCounter)
      wireCounter++
    },
    realBlockOffset: (upstreamIndex) => (realWireIndices[upstreamIndex] ?? upstreamIndex) - upstreamIndex,
  }
}

/** `content_block_start` opening the empty-text anchor block (lights the sink openBlock={0,text}). */
export function anchorStartFrame(): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "content_block_start",
    index: ANCHOR_INDEX,
    content_block: { type: "text", text: "" },
  })
}

/** Empty `text_delta` on the anchor block — the frame that actually resets CC's 300s watchdog. */
export function anchorDeltaFrame(): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "content_block_delta",
    index: ANCHOR_INDEX,
    delta: { type: "text_delta", text: "" },
  })
}

/** `content_block_stop` closing the anchor at commit / terminal failure (empty text — known-benign). */
export function anchorStopFrame(): ServerSentEventMessage {
  return anthropicSseFrame({ type: "content_block_stop", index: ANCHOR_INDEX })
}

/**
 * Fabricated `message_start` envelope for the pre-response silence window, used when the upstream
 * stalls before ever emitting its own `message_start` (spec keepalive timeout-safety §10.2). `model`
 * is the pre-resolved name (the pre-response window has not yet destructured the real env), and the
 * fake `id` + zeroed `usage` are an accepted wire/billing divergence (richest-data-flow ADR §2). This
 * builder ONLY constructs the frame; marking the forwarded record `synthetic:"synthetic-message-start"`
 * is the sampling point's responsibility. Routed through `anthropicSseFrame` so the `event:` line
 * (= `message_start`) invariant holds.
 */
export function syntheticMessageStartFrame(model: string, reqId: string): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "message_start",
    message: {
      id: `msg_synthetic_${reqId}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

/**
 * Shift the `index` of a content_block_* Anthropic SSE ClientFrame by `offset` (used when a
 * pre-commit anchor reserved index 0, so all real blocks flush at +1). Only content_block_*
 * frames carry a block index — message_delta / message_stop / non-JSON are returned unchanged.
 */
export function remapAnthropicBlockIndex(frame: ServerSentEventMessage, offset: number): ServerSentEventMessage {
  if (offset === 0 || typeof frame.data !== "string") return frame
  let payload: { type?: unknown; index?: unknown }
  try {
    payload = JSON.parse(frame.data) as { type?: unknown; index?: unknown }
  } catch {
    return frame // non-JSON (e.g. "[DONE]") — not a block frame
  }
  if (typeof payload.type === "string" && payload.type.startsWith("content_block_") && typeof payload.index === "number") {
    return anthropicSseFrame({
      ...(payload as Record<string, unknown>),
      type: payload.type,
      index: payload.index + offset,
    })
  }
  return frame
}

/**
 * Close off an injected empty-text keepalive anchor block before a TERMINAL error frame (spec
 * 2026-07-08-buffered-keepalive-empty-text-anchor §10.5 / §3.4). When the handler-owned unique injector
 * lit a synthetic empty-text anchor `content_block_start@0` during a pre-response / mid-stream silence
 * window (`empty_text` mode) and the request THEN fails, the client is otherwise left with an OPEN
 * `content_block@0` immediately followed by an `event: error` — a protocol-incomplete stream. Emitting the
 * anchor's `content_block_stop@0` (`anchorHooks.stopFrame`, routed via `writeAnchor` → `synthetic:"anchor"`)
 * BEFORE the error frame keeps the block structure balanced (empty-text block → known-benign, §3.6).
 *
 * `freezeHeartbeat` first: a terminal failure has NO subsequent real stream (this is an error terminus,
 * UNLIKE the live-reconcile close-off §10.3, which still has real blocks streaming after it → must NOT
 * freeze), so freezing is harmless AND prevents a heartbeat tick racing the error frame.
 *
 * `anchorState.anchorClosed` is the UNIVERSAL idempotency guard shared across every close-off site (this
 * primitive at the handler pre-pump branches + the pump terminal branches, the live-reconcile
 * `reconcileLiveFrame`, and the driver's buffered commit/terminal close-off — all set/check it), so the
 * anchor is closed EXACTLY once no matter which terminus fires first. Inert (byte-equivalent to the
 * no-anchor path) when no anchor was injected (`injected` false), when only a message_start envelope was
 * injected (`enveloped_ping` → `anchorBlockOpen` false: no block to balance), or when the anchor is
 * already closed. The `writeAnchor`/`freezeHeartbeat` optional-chaining tolerates array/WS sinks (no-op).
 * `anchorState` is optional so the pump's `ping`-mode terminal branches (which thread an undefined
 * `anchorState`) can call it unconditionally — undefined short-circuits to a no-op.
 */
export async function closeAnchorIfOpen(sink: ClientSink, anchorHooks: AnchorHooks | undefined, anchorState: AnchorState | undefined): Promise<void> {
  if (anchorHooks && anchorState?.injected && anchorState.anchorBlockOpen && !anchorState.anchorClosed) {
    anchorState.anchorClosed = true
    sink.freezeHeartbeat?.()
    await sink.writeAnchor?.(anchorHooks.stopFrame)
  }
}

/**
 * The UNIQUE synthetic keepalive injector (spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.1.5
 * C1). The Anthropic handler builds ONE per streaming request and attaches it to the sink's
 * `heartbeat.injectAnchor` at sink construction — so it fires on an idle heartbeat tick with NO open
 * block INDEPENDENTLY of the driver/pump. This is the crux of the pre-response fix: while `await p`
 * (runRequest) is still pending the pump/driver never run, yet the sink's heartbeat is already ticking;
 * the old driver-bound injector (bound only inside `runResponseBufferedSink`) was therefore inert in that
 * window and fell back to a bare ping → 300s CC disconnect.
 *
 * On the first idle tick it: (1) forwards the REAL captured message_start when the driver's buffered
 * drain already saw one (`state.capturedMessageStart`, UNMARKED — it is a real upstream frame), else
 * FABRICATES one (`anchor.syntheticMessageStart`, marked `synthetic-message-start`) so the client stream
 * is well-formed enough to open a block (live pre-response silence, or the buffered pre-message_start
 * window); (2) writes the synthetic empty-text anchor `content_block_start@0` (`writeAnchor` →
 * `noteBlockState` lights openBlock={0,text}); (3) writes the first empty `text_delta@0` (the frame that
 * resets CC's 300s watchdog). Subsequent idle ticks see openBlock={0,text} and emit block-aware empty
 * text_deltas via the provider — no injector re-entry (the `injected` guard).
 *
 * `state` is SHARED with the driver's buffered commit/close-off/remap and (Phase 4) the live-path
 * reconciliation, so `injected`/`messageStartForwarded` flip is observed on ONE object. It flips them
 * SYNCHRONOUSLY before the first `await` (spec §3.3 B1/C1): once the anchor's `content_block_start@0` is
 * enqueued, `injected` is already true, so a commit-branch snapshot can never read the torn mid-state
 * (which would skip the +1 remap and collide two index-0 blocks). `getSink` reads the sink at CALL time
 * (the sink construction args are evaluated before the sink exists, so the handler bridges via a
 * `let sinkRef` holder). Returns false — gracefully, re-arming the tick to a ping — only when the sink is
 * not yet wired, the anchor is already injected, or there is neither a real nor a synthesizable
 * message_start (defensive: `empty_text` always supplies `syntheticMessageStart`). Rejects ONLY if a
 * `sink.write` rejects (the client is already gone mid-write); the tick's `.catch` re-arms + emits one
 * keepalive.
 */
export function makeSyntheticAnchorInjector(args: {
  anchor: AnchorHooks
  state: AnchorState
  getSink: () => ClientSink | undefined
  resolvedName: string
  reqId: string
}): () => Promise<boolean> {
  const { anchor, state, getSink, resolvedName, reqId } = args
  return async (): Promise<boolean> => {
    const sink = getSink()
    if (!sink || state.injected) return false
    if (state.messageStartForwarded) {
      // A real message_start ALREADY reached the client via the live pump (an early upstream message_start
      // forwarded before this first idle tick — e.g. /responses `response.created` then a long reasoning
      // silence, recorded by `reconcileLiveFrame`). The wire forbids a second message_start, so do NOT emit
      // one: open ONLY the anchor block@0 + first empty text_delta to reset CC's 300s watchdog. Sync-flip
      // `injected`+`anchorBlockOpen` before the first await (race-free vs the commit snapshot, as below).
      state.injected = true
      state.anchorBlockOpen = true
      await (sink.writeAnchor ?? sink.write)(anchor.startFrame) // "anchor"; noteBlockState → openBlock={0,text}
      await (sink.writeKeepalive ?? sink.write)(anchor.deltaFrame) // "keepalive": empty text_delta resets CC's 300s watchdog
      return true
    }
    const real = state.capturedMessageStart
    if (real) {
      // C1/B1 sync-flip (before the first await — race-free vs the commit snapshot; see docstring).
      // `anchorBlockOpen` flips HERE too (not after the writeAnchor await): once `injected` is true the
      // injector is COMMITTED to opening the anchor block@0, so the buffered commit's `injected`+
      // `anchorBlockOpen` snapshot can never read `injected:true, anchorBlockOpen:false` (which would wrongly
      // skip the +1 remap). See {@link makeSyntheticEnvelopeInjector} for the enveloped_ping counterpart that
      // leaves it false.
      state.injected = true
      state.messageStartForwarded = true
      state.anchorBlockOpen = true
      await sink.write(real) // real captured → forwarded UNMARKED (a real upstream frame)
    } else {
      const synthesize = anchor.syntheticMessageStart
      // Need SOME message_start to open a well-formed prelude; without a synthesizer we cannot (defensive:
      // `empty_text` always supplies `syntheticMessageStart`) — bail so the tick re-arms to a ping.
      if (!synthesize) return false
      state.injected = true
      state.messageStartForwarded = true
      state.anchorBlockOpen = true
      await (sink.writeSyntheticEnvelope ?? sink.write)(synthesize(resolvedName, reqId)) // fabricated → "synthetic-message-start"
    }
    await (sink.writeAnchor ?? sink.write)(anchor.startFrame) // "anchor"; noteBlockState → openBlock={0,text}
    await (sink.writeKeepalive ?? sink.write)(anchor.deltaFrame) // "keepalive": empty text_delta resets CC's 300s watchdog
    return true
  }
}

/**
 * The ENVELOPE-ONLY synthetic keepalive injector for `enveloped_ping` mode (spec §10.6). A leaner sibling of
 * {@link makeSyntheticAnchorInjector}: on the first idle tick it forwards ONLY the `message_start` envelope
 * (the REAL captured one when the buffered drain already saw it, else a FABRICATED one marked
 * `synthetic-message-start`) and flips `injected` + `messageStartForwarded` — but does NOT open a synthetic
 * anchor content block, does NOT write an empty text_delta, and leaves `anchorBlockOpen` FALSE. The client
 * therefore receives a well-formed `message_start` (the "message envelope") but the keepalive itself stays a
 * BARE ping: the anchor branch in the heartbeat tick sees no open block AND `anchorAttempted` already set
 * (this injector ran once), so every subsequent idle tick falls back to the provider/ping frame
 * (= {@link ANTHROPIC_PING} for this mode). Because `anchorBlockOpen` stays false, the live reconcile
 * ({@link reconcileLiveFrame}) and the buffered commit pass real content blocks through at their ORIGINAL
 * index (no +1 remap) and never write a close-off `stop@0` — they only DROP the upstream's own duplicate
 * `message_start`.
 *
 * Positioning (spec §10.6): `enveloped_ping` is an experimental hook expected to still time out at CC's 300s
 * watchdog (exp/cc-idle-280s/REPORT.md armP: even a fully-open content block + bare ping disconnected at
 * 300s, so a message_start-only envelope + bare ping almost certainly does too). It is NOT a production-safe
 * mode; `empty_text` remains the default. Kept as a ready entry point for future watchdog experiments.
 *
 * Like {@link makeSyntheticAnchorInjector} it flips its state flags SYNCHRONOUSLY before the first `await`
 * (race-free vs the buffered commit snapshot) and returns false — re-arming the tick to a ping — only when
 * the sink is not yet wired, the envelope is already injected, or there is neither a real nor a synthesizable
 * message_start. Rejects ONLY if the single `sink.write` rejects (the client is already gone).
 */
export function makeSyntheticEnvelopeInjector(args: {
  anchor: AnchorHooks
  state: AnchorState
  getSink: () => ClientSink | undefined
  resolvedName: string
  reqId: string
}): () => Promise<boolean> {
  const { anchor, state, getSink, resolvedName, reqId } = args
  return async (): Promise<boolean> => {
    const sink = getSink()
    if (!sink || state.injected) return false
    if (state.messageStartForwarded) {
      // A real message_start already reached the client via the live pump (recorded by
      // `reconcileLiveFrame`). This mode injects ONLY an envelope, so with the envelope already on the wire
      // there is nothing left to inject — mark `injected` (no second message_start) and fall to bare pings.
      state.injected = true
      return true
    }
    const real = state.capturedMessageStart
    if (real) {
      // Sync-flip before the await (race-free vs the commit snapshot). `anchorBlockOpen` stays FALSE — this
      // mode injects NO anchor block, so real blocks flush at their original index (no remap, no close-off).
      state.injected = true
      state.messageStartForwarded = true
      await sink.write(real) // real captured → forwarded UNMARKED (a real upstream frame)
    } else {
      const synthesize = anchor.syntheticMessageStart
      // Need SOME message_start to open the envelope; without a synthesizer bail so the tick re-arms to a ping.
      if (!synthesize) return false
      state.injected = true
      state.messageStartForwarded = true
      await (sink.writeSyntheticEnvelope ?? sink.write)(synthesize(resolvedName, reqId)) // fabricated → "synthetic-message-start"
    }
    // No anchor block, no empty delta: the next idle tick (no open block + anchorAttempted already set) falls
    // back to a bare ping — exactly the `enveloped_ping` semantics.
    return true
  }
}
