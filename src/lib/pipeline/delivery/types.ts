import type { ClientFrameEnvelope } from "../stream/frame-envelope"
import type {
  //
  ClientFrame,
  GenerationWireState,
  LegSource,
  LegToken,
  WireBlockMapping,
} from "../types"

/** Synthetic provenance selected by the delivery engine's dedicated sink port. */
export type DeliverySyntheticKind = "keepalive" | "anchor" | "synthetic-message-start" | "synthetic"

export type {
  //
  LegToken,
  WireBlockMapping,
} from "../types"

export type WireWriteSpec =
  | Readonly<{ kind: "real"; frame: ClientFrame }>
  | Readonly<{ kind: "anchor"; frame: ClientFrame }>
  | Readonly<{ kind: "keepalive"; frame: ClientFrame }>

export interface WireEnvelopeFactory {
  real(frame: ClientFrame): WireWriteSpec
  anchor(frame: ClientFrame): WireWriteSpec
  keepalive(frame: ClientFrame): WireWriteSpec
}

export interface WireBlockAllocationPort {
  readonly wireState?: GenerationWireState
  allocateAndWriteAnchor(build: (ctx: { wireIndex: number; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>): Promise<number | undefined>
  withAllocatedRealBlock(
    upstreamIndex: number,
    build: (ctx: { mapping: WireBlockMapping; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>,
  ): Promise<WireBlockMapping | undefined>
  beginLeg(kind: "primary" | "continuation" | "recovery", source: LegSource): Promise<LegToken>
  closeOpenAnchor(
    buildStop: (index: number, envelope: WireEnvelopeFactory) => WireWriteSpec,
    mode: "before-real" | "terminal",
  ): Promise<"closed" | "none" | "write-error">
  writeBlockFrame(leg: LegToken, upstreamIndex: number, frame: ClientFrame): Promise<"written" | "no-mapping" | "write-error">
}

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
  /** Maximum time without a client-visible content_block_delta before escalating from the normal heartbeat. 0 disables escalation. */
  readonly contentDeadlineMs?: number
  /** Protocol-specific content delta emitted when escalation is due and a real block is open. */
  contentFrame?(ledger: ClientBlockLedger): ClientFrame
  /** Protocol-specific pre-content scaffold + first content delta emitted when escalation is due with no block open. */
  injectContentScaffold?(): Promise<boolean>
}

/** First terminal command wins; protocol-specific balancing is supplied by the caller. */
export type DeliveryTerminalCommand =
  | { kind: "complete"; frames?: ReadonlyArray<DeliveryFrame> }
  | { kind: "upstream-exhausted"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "upstream-nonretryable"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "request-cancelled"; frames: ReadonlyArray<DeliveryFrame> }
  | { kind: "client-aborted" }
