export type ObservationAtSnapshot = "observed-before-snapshot" | "not-observed-before-snapshot" | "unavailable-at-source"

export interface BoundedObservationText {
  value: string | null
  originalByteLength: number
  truncated: boolean
}

export type SnapshotScalar<T> =
  | { availability: "observed"; value: T }
  | { availability: "not-observed-before-snapshot" }
  | { availability: "unavailable-at-source"; reason: BoundedObservationText }

export type EvidenceCapture =
  | { availability: "captured"; digest: string; byteLength: number; encoding: "binary" }
  | { availability: "unavailable-at-source"; reason: BoundedObservationText }
  | { availability: "unavailable-at-capture"; byteLength: number | null; reason: BoundedObservationText }

export interface GoawayEventSnapshot {
  sequence: number
  errorCode: number
  lastStreamID: number
  lastStreamIdOrder: "first" | "non-increasing" | "protocol-error-increase"
  opaqueDataLength: SnapshotScalar<number>
  evidence: EvidenceCapture
}

export type GoawayProtocolViolation =
  | { availability: "none" }
  | {
      availability: "unattributed-protocol-error-before-callback"
      code: "PROTOCOL_ERROR"
      offendingFrame: "unavailable-at-source"
      attribution: "unattributed"
      reason: BoundedObservationText
    }
  | {
      availability: "visible-callback"
      code: "PROTOCOL_ERROR"
      offendingSequence: number
    }

export type GoawaySnapshot =
  | {
      availability: "not-observed-before-snapshot"
      events: readonly []
      protocolViolation: { availability: "none" }
    }
  | {
      availability: "unavailable-at-source"
      events: readonly []
      protocolViolation: Extract<GoawayProtocolViolation, { availability: "unattributed-protocol-error-before-callback" }>
    }
  | {
      availability: "observed-before-snapshot"
      events: readonly [GoawayEventSnapshot, ...Array<GoawayEventSnapshot>]
      protocolViolation: GoawayProtocolViolation
    }

/**
 * The h2 CONNECTION this stream ran on, sampled when the stream reached its terminal.
 *
 * Why it is on the per-stream snapshot: the sharpest way to tell a connection-level event apart from a per-stream cancel is whether SIBLING streams on the same connection died at the same moment — and that question needs a shared key in the persisted record. `rstCode` cannot answer it, because a local abort, a genuine peer CANCEL and a dead connection all arrive as 8 (measured, exp/h2-termination-observability/).
 *
 * ⚠️ `sessionId` here is the H2 CONNECTION domain. It is NOT `HistoryEntry.sessionId` / `EntrySummary.sessionId`, which identifies a client conversation. Keep them apart; conflating them destroys the discriminating power of both.
 *
 * Counters are sampled AT THE TERMINAL, not streamed: one PING observation per cycle is not copied to every sibling dispatch, so a long-lived session cannot inflate any single record.
 */
export interface TransportSessionSnapshot {
  sessionId: string
  origin: string
  /** Config generation the connection was created under, so a reconcile mid-incident is visible. */
  generation: number
  lifecycleAtSnapshot: "active" | "retiring"
  /** Sibling load at the terminal: 1 means this stream was alone, so a connection-level cause has no corroborating victim. */
  activeStreamCountAtSnapshot: number
  ping: {
    sent: number
    acked: number
    /** sent − acked at the terminal. Non-zero here says the peer had stopped answering control frames before the stream died. */
    outstanding: number
    lastRttMs: number | undefined
    lastAckEpochMs: number | undefined
    lastError: string | undefined
  }
}

export interface TransportTerminationSnapshot {
  schemaVersion: 1
  firstObservedSignal: "end" | "error" | "close-before-end" | "local-cancel"
  terminalEpochMs: number
  headersReceived: boolean
  streamId: number | null
  rstCode: number | null
  error: {
    code: BoundedObservationText
    message: BoundedObservationText
  }
  localCancel: {
    source: "body-cancel" | "post-response-signal-abort" | "other-local" | null
    reason: BoundedObservationText
  }
  trailers: ObservationAtSnapshot
  physicalClose: ObservationAtSnapshot
  goaway: GoawaySnapshot
  /** `null` when the recorder was built without a session source (bare-recorder unit tests), never invented. */
  session: TransportSessionSnapshot | null
}

export interface GoawayFreezeResult<Lease> {
  snapshot: GoawaySnapshot
  operationLease: Lease
}

export interface GoawaySnapshotSource<Lease = null> {
  freezeAtTerminal(): GoawayFreezeResult<Lease>
}

export interface Http2TerminationCommitPort {
  trySetTransportTermination(build: (goaway: GoawaySnapshot) => TransportTerminationSnapshot): boolean
}
