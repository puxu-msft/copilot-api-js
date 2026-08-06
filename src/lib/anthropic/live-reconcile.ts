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
 * {@link reconcileLiveFrame} is the pure envelope-drop/remap transform. {@link makeReconcilingSink} is the
 * live-only decorator that asks the generation owner to close any open anchor before a real start, error,
 * or message terminator, then forwards the pure transform result. The decorator never mints or writes an
 * anchor frame itself; the owner selects the allocated index, synthetic marker, serializer, and failure
 * classification. Both layers read the handler-owned {@link AnchorState} only for the temporary M1–M4
 * injection/remap bridge; close idempotency lives exclusively in the owner.
 */

import type { OwnerFailure } from "~/lib/pipeline/delivery/owner-failure"
import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
  WireBlockAllocationPort,
} from "~/lib/pipeline/types"

import { DeliveryOwnerError } from "~/lib/pipeline/delivery/session"
import { StreamClientAbortError } from "~/lib/stream"

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
 * Reconcile one upstream frame against the injected prelude. This pure transform has only three outcomes:
 * passthrough before injection, drop a duplicate `message_start`, or apply the temporary allocator-backed
 * bridge remap after an empty-text anchor reserved a wire index. It never creates a stop frame and never
 * mutates `anchorClosed`; close authority and idempotency belong to the delivery owner invoked by the
 * decorator. `enveloped_ping` leaves `anchorBlockOpen` false and therefore remains byte-identical.
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

  return [hooks.remap(frame, state.wireState.allocator.anchorsOpened() > 0 ? 1 : 0)]
}

/**
 * Decorate a live-pump {@link ClientSink} so every real `write` is routed through {@link reconcileLiveFrame}
 * (spec §10.3 / §10.1.5 C2). ONLY the live pump's sink is decorated — the buffered path keeps the RAW sink
 * (its remap is driver-internal), so `remapAnthropicBlockIndex` (non-idempotent: index+offset) is never
 * applied twice. One request is EITHER buffered OR live (the pump branches once), so the two remaps are
 * naturally mutually exclusive; this is NOT a blind decorator over a single shared sink.
 *
 * Only `write` is transformed. Public non-write methods forward to the inner sink unchanged. The owner-only
 * anchor write capability is deliberately absent from {@link ClientSink}, so the decorator cannot regain a
 * second close authority by aliasing or extracting a stop frame. On a trigger frame it first invokes
 * `closeOpenAnchor`; the owner writes and marks the stop in the same serializer, then the decorator forwards
 * the remapped real frame. Client-gone becomes `StreamClientAbortError`; other owner failures retain a typed
 * {@link LiveOwnerFailureError} for the handler/driver boundary to classify without string parsing.
 */
export class LiveOwnerFailureError extends Error {
  readonly failure: OwnerFailure

  constructor(failure: OwnerFailure) {
    super(`[delivery] live anchor close rejected: ${failure.reason}`)
    this.name = "LiveOwnerFailureError"
    this.failure = failure
  }
}

export function makeReconcilingSink(inner: ClientSink, state: AnchorState, hooks: ReconcileHooks, port?: WireBlockAllocationPort): ClientSink {
  const sink: ClientSink = {
    write: async (frame: ClientFrame): Promise<void> => {
      if (port?.wireState && (isContentBlockStart(frame) || isErrorEvent(frame) || isMessageTerminator(frame))) {
        try {
          const closed = await port.closeOpenAnchor(
            (index, envelope) => envelope.anchor(hooks.stopFrame(index)),
            isContentBlockStart(frame) ? "before-real" : "terminal",
          )
          if (!closed.ok) {
            if (closed.reason === "client-gone") throw new StreamClientAbortError()
            throw new LiveOwnerFailureError(closed)
          }
        } catch (error) {
          if (error instanceof DeliveryOwnerError && error.committed) throw new LiveOwnerFailureError({ ok: false, reason: "wire-torn", committed: false })
          throw error
        }
      }
      for (const f of reconcileLiveFrame(frame, state, hooks)) await inner.write(f)
    },
    // Forward every PUBLIC non-write method. The owner-only anchor capability is intentionally withheld.
    writeSynthetic: inner.writeSynthetic ? (frame) => inner.writeSynthetic?.(frame) ?? Promise.resolve() : undefined,
    writeKeepalive: inner.writeKeepalive ? (frame) => inner.writeKeepalive?.(frame) ?? Promise.resolve() : undefined,
    writeSyntheticEnvelope: inner.writeSyntheticEnvelope ? (frame) => inner.writeSyntheticEnvelope?.(frame) ?? Promise.resolve() : undefined,
    freezeHeartbeat: inner.freezeHeartbeat ? () => inner.freezeHeartbeat?.() : undefined,
    suspendHeartbeat: inner.suspendHeartbeat ? () => inner.suspendHeartbeat?.() : undefined,
    resumeHeartbeat: inner.resumeHeartbeat ? () => inner.resumeHeartbeat?.() : undefined,
    close: inner.close ? () => inner.close?.() : undefined,
    finalize: inner.finalize ? () => inner.finalize?.() : undefined,
  }
  // Deliberately do NOT inherit delivery identity. This decorator rewrites/drops/reorders frames; if the
  // winner-aware driver resolves it as a delivery session, winner writes bypass `sink.write` and therefore
  // bypass reconciliation. The fallback through this decorator is required for wire correctness, at the
  // existing cost that live winner frames do not carry candidateId attribution.
  return sink
}
