import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * The one answer to "what Anthropic wire event is this frame?".
 *
 * An Anthropic SSE frame carries its type twice — on the `event:` line and as the payload's top-level `type` — and upstream does not always send both. A raw upstream error frame in particular arrives as `event: error` with a body of just `{ error: { ... } }`, and the canonical `type` is only added later by the error-shaping rewrite, which is a setting the user can turn off.
 *
 * Every site that answered this question for itself picked one source and missed the other: five read only the payload (`live-reconcile`, `stream`, `commit-boundaries`, `delivery/session`, `precontent-recovery-sink-chain`), one read only the event line (`error-frame-canonical-rewrite`). The payload-only readers all fail to see a raw upstream error frame; the consequences ranged from a missed commit boundary to an upstream terminal error being retried four times as if the stream had merely been cut.
 *
 * Precedence is payload first, event line second, which makes adopting this strictly additive: any frame that already declares a payload `type` classifies exactly as it did before.
 */
export function anthropicWireFrameType(frame: Pick<ClientFrame, "event" | "data">): string | undefined {
  let payloadType: unknown
  try {
    if (frame.data !== undefined) payloadType = (JSON.parse(frame.data) as { type?: unknown }).type
  } catch {
    // An unparseable body is not a classification failure here — the event line may still name the frame.
    payloadType = undefined
  }
  if (typeof payloadType === "string") return payloadType
  return frame.event
}

/** Convenience for the common "is this the upstream's terminal error frame?" question. */
export function isAnthropicErrorFrame(frame: Pick<ClientFrame, "event" | "data">): boolean {
  return anthropicWireFrameType(frame) === "error"
}

/**
 * Fill in a parsed Anthropic stream event's `type` from the SSE `event:` line when the payload omitted it.
 *
 * The accumulator switches on `type` and silently ignores anything it cannot name, so a raw upstream error frame — `event: error` with a body of just `{ error: { ... } }` — left `acc.streamError` unset and made the terminal look like a truncation.
 * Every feed into the accumulator needs this, so it lives here rather than being repeated at each call site; callers keep their own parse error handling.
 */
export function nameAnthropicEventFromWire<T>(frame: Pick<ClientFrame, "event" | "data">, parsed: T): T {
  if (typeof (parsed as { type?: unknown } | undefined)?.type === "string") return parsed
  const wireType = anthropicWireFrameType(frame)
  return wireType === undefined ? parsed : ({ ...parsed, type: wireType } as T)
}
