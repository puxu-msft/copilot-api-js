import type { ClientFrameEnvelope } from "../stream/frame-envelope"

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
