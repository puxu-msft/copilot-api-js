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
 */
export const ANCHOR_INDEX = 0

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
    const real = state.capturedMessageStart
    if (real) {
      // C1/B1 sync-flip (before the first await — race-free vs the commit snapshot; see docstring).
      state.injected = true
      state.messageStartForwarded = true
      await sink.write(real) // real captured → forwarded UNMARKED (a real upstream frame)
    } else {
      const synthesize = anchor.syntheticMessageStart
      // Need SOME message_start to open a well-formed prelude; without a synthesizer we cannot (defensive:
      // `empty_text` always supplies `syntheticMessageStart`) — bail so the tick re-arms to a ping.
      if (!synthesize) return false
      state.injected = true
      state.messageStartForwarded = true
      await (sink.writeSyntheticEnvelope ?? sink.write)(synthesize(resolvedName, reqId)) // fabricated → "synthetic-message-start"
    }
    await (sink.writeAnchor ?? sink.write)(anchor.startFrame) // "anchor"; noteBlockState → openBlock={0,text}
    await (sink.writeKeepalive ?? sink.write)(anchor.deltaFrame) // "keepalive": empty text_delta resets CC's 300s watchdog
    return true
  }
}
