/**
 * LIVE-path anchor reconciliation (spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.3).
 *
 * The buffered path remaps ONCE at commit-flush (driver.ts): it closes the anchor off, drops the
 * duplicate `message_start`, and shifts every real block +1 in a single pass over the buffer. The LIVE
 * path has no buffer — real upstream frames stream through `sink.write` one at a time — so the same
 * reconciliation has to be applied INCREMENTALLY as each real frame arrives, AFTER the handler's unique
 * injector already synthesized a prelude (fabricated message_start + anchor block@0 + empty text_delta)
 * during the pre-response silence window.
 *
 * {@link reconcileLiveFrame} is the pure transform; {@link makeReconcilingSink} is the sink decorator
 * that wires it onto the live pump's `write` (§10.1.5 C2 — applied ONLY to the live path so it never
 * double-remaps the buffered path, whose remap lives inside the driver). Both read the SHARED
 * handler-owned {@link AnchorState} (§10.1.5 H1), so `injected` / `messageStartForwarded` / `anchorClosed`
 * observed here are the same object the injector flips.
 */

import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

/** Is this rendered client frame a real `content_block_start`? (parses the JSON `type`; non-JSON → false). */
function isContentBlockStart(frame: ClientFrame): boolean {
  if (typeof frame.data !== "string") return false
  try {
    return (JSON.parse(frame.data) as { type?: unknown }).type === "content_block_start"
  } catch {
    return false // non-JSON frame (e.g. a keepalive line) — not a content_block_start
  }
}

/**
 * Is this rendered client frame a terminal `error` SSE event? Two live-path producers forward one through
 * the normal `sink.write` (→ this reconcile), BEFORE any real content block: a terminal upstream `error`
 * event (H2 — e.g. `overloaded_error`, accumulated to `acc.streamError`) and the refusal→error S5 rewrite
 * (a zero-content refusal). Either arriving while the anchor is still open would otherwise be forwarded
 * straight after an OPEN `content_block@0` — the same protocol-incomplete shape §10.5 eliminates. Treating
 * it as a close-off trigger (like the first `content_block_start`) inserts `stop@0` BEFORE it.
 */
function isErrorEvent(frame: ClientFrame): boolean {
  if (typeof frame.data !== "string") return false
  try {
    return (JSON.parse(frame.data) as { type?: unknown }).type === "error"
  } catch {
    return false // non-JSON frame — not an error event
  }
}

/**
 * Is this a message-level terminator (`message_delta` / `message_stop`)? If one arrives while the anchor is
 * still open, NO real `content_block_start` ever opened — a ZERO-CONTENT completion. The message is closing
 * with a dangling open `content_block@0` (protocol-incomplete). Closing the anchor off before it makes the
 * live path SYMMETRIC with the buffered commit (which always closes on commit, driver.ts) — the anchor is
 * closed on EVERY terminus, not just failures. In a normal (≥1 block) response the first `content_block_start`
 * already flipped `anchorClosed`, so this never fires there (the `!anchorClosed` guard short-circuits).
 */
function isMessageTerminator(frame: ClientFrame): boolean {
  if (typeof frame.data !== "string") return false
  try {
    const t = (JSON.parse(frame.data) as { type?: unknown }).type
    return t === "message_delta" || t === "message_stop"
  } catch {
    return false // non-JSON frame — not a message terminator
  }
}

/** The subset of {@link AnchorHooks} the live reconciliation needs (message_start predicate + close-off + remap). */
export type ReconcileHooks = Pick<AnchorHooks, "isMessageStart" | "stopFrame" | "remap">

/**
 * Reconcile ONE real upstream frame against the injected prelude (spec §10.3 / §10.6). Returns the frame
 * sequence to write (0, 1, or 2 frames). The `anchorBlockOpen` flag on the shared {@link AnchorState}
 * discriminates the two injected preludes:
 *
 *   - NOT injected → `[frame]` (transparent passthrough — byte-identical to the no-anchor live path; a
 *     fast response that produced real content before the first idle tick never injected, so `injected`
 *     stays false and every frame flows through untouched).
 *   - injected + `message_start` → `[]` (DROP it: the client already received the injected message_start,
 *     and the protocol forbids a second one — the "already forwarded a message_start → skip any later one"
 *     rule, unifying live + the buffered commit dedup). Applies to BOTH preludes. Flips `messageStartForwarded`.
 *   - injected + `anchorBlockOpen` (`empty_text`) — the injector reserved a synthetic anchor block@0:
 *       - FIRST real `content_block_start` (anchor not yet closed) → `[stopFrame, remap(frame, 1)]` (close the
 *         anchor off at index 0, then emit the real block shifted to index+1 so it can't collide with the
 *         anchor's reserved index 0). Flips `anchorClosed`.
 *       - a terminal `error` event before any real block (anchor not yet closed) → `[stopFrame, frame]` (close
 *         the anchor off BEFORE the forwarded error so the client never sees an OPEN block straight into an
 *         error — H2 upstream error / refusal→error rewrite, spec §10.5). `remap` leaves the non-block error
 *         frame unchanged. Flips `anchorClosed`.
 *       - a `message_delta` / `message_stop` before any real block (anchor not yet closed) → `[stopFrame, frame]`
 *         (ZERO-CONTENT completion: no real block ever opened, so close the anchor off before the message
 *         terminator — symmetry with the buffered commit close-off). Flips `anchorClosed`.
 *       - any other `content_block_*` → `[remap(frame, 1)]` (shift by +1; the anchor still occupies index 0).
 *       - `message_delta` / `message_stop` AFTER the anchor was already closed by a real block → `[remap(frame, 1)]`
 *         — `remap` returns index-less frames unchanged, so the real `stop_reason` + `usage` reach the client verbatim.
 *   - injected + `!anchorBlockOpen` (`enveloped_ping`) — only a message_start envelope was injected, NO anchor
 *     block reserved index 0 → every non-message_start frame passes through VERBATIM (`[frame]`): real content
 *     blocks keep their ORIGINAL index, and no close-off `stop@0` is written (there is no block to balance).
 *
 * PURE except for the state-flag flips (`messageStartForwarded` / `anchorClosed`) that the shared
 * {@link AnchorState} carries; it does NOT touch the sink or the heartbeat (the decorator owns writing +
 * the synthetic-marker routing of the close-off frame).
 */
export function reconcileLiveFrame(frame: ClientFrame, state: AnchorState, hooks: ReconcileHooks): Array<ClientFrame> {
  if (!state.injected) {
    // No prelude was injected → passthrough (WIRE byte-equivalent). But RECORD a real message_start that
    // streams through here: the live pump can forward an upstream message_start EARLY (e.g. /responses
    // `response.created` at t≈0) and then fall silent for the whole reasoning phase. If a later idle tick
    // then fires the injector, it must know a message_start already reached the client so it does NOT
    // fabricate a SECOND one (the wire forbids two message_start). `capturedMessageStart` is buffered-path
    // only, so this live-path flag is the sole signal for the injector's dedup.
    if (hooks.isMessageStart(frame)) state.messageStartForwarded = true
    return [frame]
  }

  if (hooks.isMessageStart(frame)) {
    state.messageStartForwarded = true
    return [] // drop the real message_start — the injected one already opened the message (both preludes)
  }

  // enveloped_ping: only a message_start envelope was injected — no anchor block occupies index 0, so real
  // content frames pass through at their ORIGINAL index (no +1 remap) and no close-off is ever written.
  if (!state.anchorBlockOpen) return [frame]

  const out: Array<ClientFrame> = []
  if ((isContentBlockStart(frame) || isErrorEvent(frame) || isMessageTerminator(frame)) && !state.anchorClosed) {
    // Close the anchor (stop@0) BEFORE this frame so the client's block structure stays balanced. Triggers:
    //   - first real `content_block_start` → then shift the real block +1 (below);
    //   - a terminal `error` event before any real block (H2 upstream error / refusal→error rewrite, §10.5);
    //   - a `message_delta` / `message_stop` before any real block (ZERO-CONTENT completion — symmetry with
    //     the buffered commit close-off, so the anchor closes on EVERY terminus, not only failures).
    // All three are non-anchor-block frames, so `remap` below leaves them unchanged; a content_block_start is
    // then shifted +1. The `!anchorClosed` guard makes this fire at most once (a normal ≥1-block stream
    // closed at its first content_block_start → later message_delta/stop pass through untouched).
    state.anchorClosed = true
    out.push(hooks.stopFrame(0))
  }
  out.push(hooks.remap(frame, 1)) // content_block_* → +1; message_delta / message_stop / error pass through
  return out
}

/**
 * Decorate a live-pump {@link ClientSink} so every real `write` is routed through {@link reconcileLiveFrame}
 * (spec §10.3 / §10.1.5 C2). ONLY the live pump's sink is decorated — the buffered path keeps the RAW sink
 * (its remap is driver-internal), so `remapAnthropicBlockIndex` (non-idempotent: index+offset) is never
 * applied twice. One request is EITHER buffered OR live (the pump branches once), so the two remaps are
 * naturally mutually exclusive; this is NOT a blind decorator over a single shared sink.
 *
 * Only `write` is transformed. Every OTHER method forwards to the inner sink unchanged: the injector's
 * `writeSyntheticEnvelope` / `writeAnchor` / `writeKeepalive` (the prelude), the heartbeat, the handler's
 * terminal `writeSynthetic` error frame, `freezeHeartbeat`, and `close` all write straight to the inner
 * sink and share its single serializer, so injected + reconciled frames never byte-interleave. The inner
 * sink methods are closures (they capture the sink's state, not `this`), so forwarding by reference is safe.
 *
 * The synthetic close-off `stopFrame` reconcile emits ahead of the first real block is routed through the
 * inner sink's `writeAnchor` (not `write`) so the forwarded track marks it `synthetic:"anchor"` — richest-
 * data-flow (a proxy-injected structural frame must be distinguishable from real content) and symmetric
 * with the buffered commit's close-off (buffered-anchor-golden). `writeAnchor` also updates the open-block
 * state (clears `openBlock={0,text}`), exactly as a real `write` would.
 */
export function makeReconcilingSink(inner: ClientSink, state: AnchorState, hooks: ReconcileHooks): ClientSink {
  return {
    write: async (frame: ClientFrame): Promise<void> => {
      const wasClosed = state.anchorClosed
      const frames = reconcileLiveFrame(frame, state, hooks)
      // reconcile just closed the anchor (false → true): its FIRST output is the synthetic close-off
      // stopFrame → write it via `writeAnchor` (synthetic:"anchor" marker + open-block clear); the
      // remaining outputs are the real remapped block frames (unmarked).
      if (!wasClosed && state.anchorClosed && frames.length > 0) {
        await (inner.writeAnchor ?? inner.write)(frames[0])
        for (let i = 1; i < frames.length; i++) await inner.write(frames[i])
        return
      }
      for (const f of frames) await inner.write(f)
    },
    // Forward every non-write method to the inner sink. The inner methods are closures over the sink's
    // state (not `this`-bound), so an optional-call wrapper forwards safely; a missing optional method
    // stays undefined so callers' feature-detection (`sink.writeAnchor ?? sink.write`) still works
    // (array / WS sinks omit the heartbeat + out-of-band writes).
    writeSynthetic: inner.writeSynthetic ? (frame) => inner.writeSynthetic?.(frame) ?? Promise.resolve() : undefined,
    writeKeepalive: inner.writeKeepalive ? (frame) => inner.writeKeepalive?.(frame) ?? Promise.resolve() : undefined,
    writeSyntheticEnvelope: inner.writeSyntheticEnvelope ? (frame) => inner.writeSyntheticEnvelope?.(frame) ?? Promise.resolve() : undefined,
    writeAnchor: inner.writeAnchor ? (frame) => inner.writeAnchor?.(frame) ?? Promise.resolve() : undefined,
    freezeHeartbeat: inner.freezeHeartbeat ? () => inner.freezeHeartbeat?.() : undefined,
    close: inner.close ? () => inner.close?.() : undefined,
  }
}
