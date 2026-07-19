import type { ClientFrameEnvelope } from "../stream/frame-envelope"
import type { ClientFrame } from "../types"

/** Synthetic provenance selected by the delivery engine's dedicated sink port. */
export type DeliverySyntheticKind = "keepalive" | "anchor" | "synthetic-message-start" | "synthetic"

/** One already client-shaped frame waiting to enter the unique wire serializer. */
export type DeliveryFrame = ClientFrameEnvelope

/** Post-reconcile block identity observed from actual client wire. */
export interface DeliveredOpenBlock {
  readonly index: number
  readonly type: string
  readonly synthetic: boolean
}

/** Wire-derived client protocol ledger. Upstream attempts never mutate it. */
export interface ClientBlockLedger {
  readonly messageEnvelope: "none" | "synthetic" | "real"
  readonly openBlocks: ReadonlyArray<DeliveredOpenBlock>
  readonly lastWriteAtMonotonic: number
  readonly semanticBlockCount: number
  readonly terminalWritten: boolean
}

/** Immutable diagnostic snapshot of one delivery session. */
export interface DeliverySnapshot {
  readonly state: "open" | "terminating" | "closed"
  readonly winnerCandidateId?: string
  readonly ledger: ClientBlockLedger
  readonly upstreamRounds: ReadonlyArray<string>
  readonly writeCount: number
}

/** Generation-owned downstream heartbeat; it reads only the post-wire ledger. */
export interface DeliveryHeartbeat {
  readonly intervalMs: number
  readonly clientAbortSignal?: AbortSignal
  frame(ledger: ClientBlockLedger): ClientFrame
  injectScaffold?(): Promise<boolean>
}

/** First terminal command wins; protocol-specific balancing is supplied by the caller. */
export type DeliveryTerminalCommand =
  | { kind: "complete"; frames?: ReadonlyArray<DeliveryFrame> }
  | { kind: "upstream-exhausted"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "upstream-nonretryable"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "request-cancelled"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "client-aborted" }
