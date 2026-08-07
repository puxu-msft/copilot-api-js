import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type {
  BoundedObservationText,
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

type EvidenceEntry = {
  capture: CapturedEvidence
  bytes: Uint8Array
}

export class RegisteredGoawayEvidence {
  readonly capture: CapturedEvidence
  readonly #bytes: Uint8Array
  #state: "registered" | "consumed" | "released" = "registered"

  constructor(digest: string, bytes: Uint8Array) {
    this.capture = Object.freeze({ availability: "captured", digest, byteLength: bytes.byteLength, encoding: "binary" })
    this.#bytes = new Uint8Array(bytes)
  }

  bytes(): Readonly<Uint8Array> {
    if (this.#state === "released") throw new Error("registered GOAWAY evidence already released")
    if (this.#state === "consumed") throw new Error("registered GOAWAY evidence already consumed")
    return this.#bytes
  }

  release(): void {
    if (this.#state !== "registered") throw new Error(`registered GOAWAY evidence already ${this.#state}`)
    this.#state = "released"
  }

  consume(): Uint8Array {
    if (this.#state !== "registered") throw new Error(`registered GOAWAY evidence already ${this.#state}`)
    this.#state = "consumed"
    return this.#bytes
  }
}

export class OperationGoawayLease {
  readonly dispatch: DispatchHandle
  readonly events: readonly GoawayEventSnapshot[]
  readonly #ledger: SessionGoawayLedger
  #released = false

  constructor(ledger: SessionGoawayLedger, dispatch: DispatchHandle, events: readonly GoawayEventSnapshot[]) {
    this.#ledger = ledger
    this.dispatch = dispatch
    this.events = events
  }

  evidenceBytes(digest: string): Readonly<Uint8Array> | null {
    this.#assertActive()
    return this.#ledger.evidenceBytes(digest)
  }

  release(): void {
    this.#assertActive()
    this.#released = true
    this.#ledger.releaseReference()
  }

  #assertActive(): void {
    if (this.#released) throw new Error("operation GOAWAY lease already released")
  }
}

export class DispatchGoawayLease implements GoawaySnapshotSource<OperationGoawayLease | null> {
  readonly dispatch: DispatchHandle
  readonly #ledger: SessionGoawayLedger
  #state: "active" | "frozen" | "released" = "active"

  constructor(ledger: SessionGoawayLedger, dispatch: DispatchHandle) {
    this.#ledger = ledger
    this.dispatch = dispatch
  }

  freezeAtTerminal(): GoawayFreezeResult<OperationGoawayLease | null> {
    this.#assertActive()
    const result = this.#ledger.freeze(this.dispatch)
    this.#state = "frozen"
    if (result.operationLease === null) this.#ledger.releaseReference()
    return result
  }

  release(): void {
    this.#assertActive()
    this.#state = "released"
    this.#ledger.releaseReference()
  }

  #assertActive(): void {
    if (this.#state !== "active") throw new Error(`dispatch GOAWAY lease already ${this.#state}`)
  }
}

export class SessionGoawayLedger {
  readonly #events: Array<GoawayEventSnapshot> = []
  readonly #evidence = new Map<string, EvidenceEntry>()
  #protocolViolation: GoawayProtocolViolation = { availability: "none" }
  #ownerOpen = true
  #references = 1

  get retainedReferenceCount(): number {
    return this.#references
  }

  acquireDispatchLease(dispatch: DispatchHandle): DispatchGoawayLease {
    if (!this.#ownerOpen) throw new Error("session GOAWAY ledger owner closed")
    this.#references += 1
    return new DispatchGoawayLease(this, dispatch)
  }

  appendObserved(input: AppendObservedInput): "appended" | "appended-protocol-error" {
    if (!this.#ownerOpen) throw new Error("session GOAWAY ledger owner closed")
    const incomingBytes = input.evidence.bytes()
    const existing = this.#evidence.get(input.evidence.capture.digest)
    if (existing && !Buffer.from(existing.bytes).equals(Buffer.from(incomingBytes))) throw new Error(`GOAWAY evidence digest collision: ${input.evidence.capture.digest}`)

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
    const consumedBytes = input.evidence.consume()
    if (!existing) this.#evidence.set(input.evidence.capture.digest, { capture: input.evidence.capture, bytes: consumedBytes })
    if (!increased) return "appended"
    this.#protocolViolation = { availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: sequence }
    return "appended-protocol-error"
  }

  recordUnattributedProtocolError(reason: BoundedObservationText): "recorded" | "already-recorded" {
    if (this.#protocolViolation.availability !== "none") return "already-recorded"
    this.#protocolViolation = {
      availability: "unattributed-protocol-error-before-callback",
      code: "PROTOCOL_ERROR",
      offendingFrame: "unavailable-at-source",
      attribution: "unattributed",
      reason,
    }
    return "recorded"
  }

  closeSessionOwner(): void {
    if (!this.#ownerOpen) throw new Error("session GOAWAY ledger owner already closed")
    this.#ownerOpen = false
    this.releaseReference()
  }

  freeze(dispatch: DispatchHandle): GoawayFreezeResult<OperationGoawayLease | null> {
    if (this.#events.length === 0) {
      if (this.#protocolViolation.availability === "unattributed-protocol-error-before-callback") {
        return {
          snapshot: {
            availability: "unavailable-at-source",
            events: [],
            protocolViolation: this.#protocolViolation,
          },
          operationLease: null,
        }
      }
      return {
        snapshot: {
          availability: "not-observed-before-snapshot",
          events: [],
          protocolViolation: { availability: "none" },
        },
        operationLease: null,
      }
    }
    const events = Object.freeze([...this.#events]) as readonly [GoawayEventSnapshot, ...Array<GoawayEventSnapshot>]
    return {
      snapshot: {
        availability: "observed-before-snapshot",
        events,
        protocolViolation: this.#protocolViolation,
      },
      operationLease: new OperationGoawayLease(this, dispatch, events),
    }
  }

  evidenceBytes(digest: string): Readonly<Uint8Array> | null {
    return this.#evidence.get(digest)?.bytes ?? null
  }

  releaseReference(): void {
    if (this.#references <= 0) throw new Error("session GOAWAY ledger reference underflow")
    this.#references -= 1
    if (this.#references === 0) this.#evidence.clear()
  }
}
