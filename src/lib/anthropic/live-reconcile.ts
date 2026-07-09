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
 *       - any other `content_block_*` → `[remap(frame, 1)]` (shift by +1; the anchor still occupies index 0).
 *       - `message_delta` / `message_stop` (no block index) → `[remap(frame, 1)]` — `remap` returns
 *         index-less frames unchanged, so the real `stop_reason` + `usage` reach the client verbatim.
 *   - injected + `!anchorBlockOpen` (`enveloped_ping`) — only a message_start envelope was injected, NO anchor
 *     block reserved index 0 → every non-message_start frame passes through VERBATIM (`[frame]`): real content
 *     blocks keep their ORIGINAL index, and no close-off `stop@0` is written (there is no block to balance).
 *
 * PURE except for the state-flag flips (`messageStartForwarded` / `anchorClosed`) that the shared
 * {@link AnchorState} carries; it does NOT touch the sink or the heartbeat (the decorator owns writing +
 * the synthetic-marker routing of the close-off frame).
 */
export function reconcileLiveFrame(frame: ClientFrame, state: AnchorState, hooks: ReconcileHooks): Array<ClientFrame> {
  if (!state.injected) return [frame] // no prelude was injected → passthrough (byte-equivalent)

  if (hooks.isMessageStart(frame)) {
    state.messageStartForwarded = true
    return [] // drop the real message_start — the injected one already opened the message (both preludes)
  }

  // enveloped_ping: only a message_start envelope was injected — no anchor block occupies index 0, so real
  // content frames pass through at their ORIGINAL index (no +1 remap) and no close-off is ever written.
  if (!state.anchorBlockOpen) return [frame]

  const out: Array<ClientFrame> = []
  if (isContentBlockStart(frame) && !state.anchorClosed) {
    // First real block after the injected anchor: close the anchor (stop@0) BEFORE the real block so
    // the client's block structure stays balanced, then shift the real block to +1.
    state.anchorClosed = true
    out.push(hooks.stopFrame)
  }
  out.push(hooks.remap(frame, 1)) // content_block_* → +1; message_delta / message_stop pass through
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
