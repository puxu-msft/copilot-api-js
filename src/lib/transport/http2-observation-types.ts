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
