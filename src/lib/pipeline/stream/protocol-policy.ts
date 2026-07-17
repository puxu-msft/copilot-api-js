/**
 * Inert protocol-policy contracts for the upstream generation runtime.
 *
 * Policies classify raw frames and client-wire structures while the shared
 * runtime owns iteration, buffering, cancellation, and delivery. These
 * interfaces deliberately preserve protocol-native frames instead of defining a
 * lossy common event model.
 *
 * Phase 1 freezes the cross-layer types needed by the later response processor and delivery
 * session. Phase 2 supplies upstream terminal/error classification; Phase 3 supplies scaffold,
 * winner reconciliation, and concrete ledger-aware termination policies.
 */

import type { RequestEnvelope } from "../envelope"
import type {
  //
  ClientFrameEnvelope,
  ClientFrameSignals,
  UpstreamFrameEnvelope,
} from "./frame-envelope"

/** Semantic signals produced from one exact upstream frame. */
export interface UpstreamFrameSignals {
  readonly content: boolean
  readonly terminal: "none" | "success" | "failure"
  readonly usage?: unknown
}

/** Protocol-specific upstream observer owned by one candidate response processor. */
export interface UpstreamProtocolObserver {
  readonly snapshot: unknown
}

/** Read-only classification policy for one upstream protocol. */
export interface UpstreamProtocolPolicy {
  createObserver(env: RequestEnvelope): UpstreamProtocolObserver
  classify(frame: UpstreamFrameEnvelope, observer: UpstreamProtocolObserver): UpstreamFrameSignals
}

/** Client protocol state owned by one candidate response processor. */
export interface ClientProtocolState {
  readonly snapshot: unknown
}

/** Current client-wire block ledger consumed by delivery termination policy. */
export interface ClientBlockLedgerView {
  readonly messageEnvelope: "none" | "synthetic" | "real"
  readonly openBlocks: ReadonlyArray<Readonly<{ index: number; type: string; synthetic: boolean }>>
  readonly semanticBlockCount: number
  readonly terminalWritten: boolean
}

/** Typed terminal output plan; the delivery engine remains the sole writer. */
export interface ClientTerminationPlan {
  readonly frames: ReadonlyArray<ClientFrameEnvelope>
  readonly closeMode: "graceful" | "error" | "client-gone"
}

/** Protocol-specific client classification and terminal planning contract. */
export interface ClientProtocolPolicy<TerminalCommand = unknown> {
  createState(env: RequestEnvelope): ClientProtocolState
  classify(frame: ClientFrameEnvelope, state: ClientProtocolState): ClientFrameSignals
  terminateFromLedger(input: { command: TerminalCommand; ledger: ClientBlockLedgerView; protocolState: ClientProtocolState }): ClientTerminationPlan
}
