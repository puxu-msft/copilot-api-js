import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type {
  EvidenceCapture,
  GoawayEventSnapshot,
  GoawayFreezeResult,
  GoawayProtocolViolation,
  GoawaySnapshotSource,
  SnapshotScalar,
} from "~/lib/transport/http2-observation-types"

type CapturedEvidence = Extract<EvidenceCapture, { availability: "captured" }>
type AppendObservedInput = {
  errorCode: number
  lastStreamID: number
  opaqueDataLength: SnapshotScalar<number>
  evidence: RegisteredGoawayEvidence
}

export class RegisteredGoawayEvidence {
  readonly capture: CapturedEvidence
  readonly #bytes: Uint8Array

  constructor(digest: string, bytes: Uint8Array) {
    this.capture = Object.freeze({ availability: "captured", digest, byteLength: bytes.byteLength, encoding: "binary" })
    this.#bytes = new Uint8Array(bytes)
  }

  bytes(): Readonly<Uint8Array> {
    return this.#bytes
  }

  release(): void {}
}

export class SessionGoawayLedger {
  readonly #events: Array<GoawayEventSnapshot> = []
  #protocolViolation: GoawayProtocolViolation = { availability: "none" }

  acquireDispatchLease(dispatch: DispatchHandle): GoawaySnapshotSource<null> & { readonly dispatch: DispatchHandle } {
    return Object.freeze({
      dispatch,
      freezeAtTerminal: (): GoawayFreezeResult<null> => {
        if (this.#events.length === 0) {
          return {
            snapshot: {
              availability: "not-observed-before-snapshot",
              events: [],
              protocolViolation: { availability: "none" },
            },
            operationLease: null,
          }
        }
        return {
          snapshot: {
            availability: "observed-before-snapshot",
            events: [...this.#events] as [GoawayEventSnapshot, ...Array<GoawayEventSnapshot>],
            protocolViolation: this.#protocolViolation,
          },
          operationLease: null,
        }
      },
    })
  }

  appendObserved(input: AppendObservedInput): "appended" | "appended-protocol-error" {
    const previous = this.#events.at(-1)
    const sequence = this.#events.length + 1
    const increased = previous !== undefined && input.lastStreamID > previous.lastStreamID
    const event: GoawayEventSnapshot = Object.freeze({
      sequence,
      errorCode: input.errorCode,
      lastStreamID: input.lastStreamID,
      lastStreamIdOrder: previous === undefined ? "first" : increased ? "protocol-error-increase" : "non-increasing",
      opaqueDataLength: input.opaqueDataLength,
      evidence: input.evidence.capture,
    })
    this.#events.push(event)
    if (!increased) return "appended"
    this.#protocolViolation = { availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: sequence }
    return "appended-protocol-error"
  }
}
