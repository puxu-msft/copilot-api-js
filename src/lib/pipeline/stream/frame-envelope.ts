/**
 * Additive frame metadata for the upstream generation runtime.
 *
 * The raw protocol frame remains the source of truth. Envelopes retain its exact
 * object identity and only add orchestration metadata; they are not a normalized
 * event IR and never narrow unknown future wire fields.
 */

import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "../types"

/** Origin of one raw or rendered frame before generation winner selection. */
export type FrameProvenance =
  | Readonly<{ kind: "upstream"; dispatchId: string }>
  | Readonly<{ kind: "candidate"; candidateId: string; dispatchId: string }>
  | Readonly<{ kind: "synthetic"; syntheticKind: string }>

/** Metadata shared by upstream and client-shaped frame envelopes. */
export interface FrameEnvelopeMetadata {
  readonly sequence: number
  readonly observedAtMonotonic: number
  readonly provenance: FrameProvenance
}

/** Exact upstream frame plus additive orchestration metadata. */
export interface UpstreamFrameEnvelope<Frame extends UpstreamFrame = UpstreamFrame> extends FrameEnvelopeMetadata {
  readonly frame: Frame
}

/** Exact post-render frame plus additive orchestration metadata. */
export interface ClientFrameEnvelope<Frame extends ClientFrame = ClientFrame> extends FrameEnvelopeMetadata {
  readonly frame: Frame
}

/** Protocol-policy classification attached to, but never substituted for, a client frame. */
export interface ClientFrameSignals {
  readonly synthetic: boolean
  readonly semanticContent: boolean
  readonly blockBoundary: boolean
  readonly terminal: "none" | "success" | "valid-without-boundary" | "failure"
  readonly usage?: unknown
}

/** Wrap an exact upstream frame without cloning, freezing, or normalizing it. */
export function createUpstreamFrameEnvelope<Frame extends UpstreamFrame>(frame: Frame, metadata: FrameEnvelopeMetadata): UpstreamFrameEnvelope<Frame> {
  return Object.freeze({ frame, ...metadata })
}

/** Wrap an exact post-render frame without cloning, freezing, or normalizing it. */
export function createClientFrameEnvelope<Frame extends ClientFrame>(frame: Frame, metadata: FrameEnvelopeMetadata): ClientFrameEnvelope<Frame> {
  return Object.freeze({ frame, ...metadata })
}

/** A candidate may commit only a genuine, semantic, complete, non-failure block. */
export function isSemanticCommitBoundary(signals: ClientFrameSignals): boolean {
  return !signals.synthetic && signals.semanticContent && signals.blockBoundary && (signals.terminal === "none" || signals.terminal === "success")
}
