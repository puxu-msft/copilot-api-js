import type {
  //
  BoundedObservationText,
  GoawaySnapshotSource,
  Http2TerminationCommitPort,
  ObservationAtSnapshot,
  TransportTerminationSnapshot,
} from "./http2-observation-types"

const EMPTY_OBSERVATION_TEXT: BoundedObservationText = {
  value: null,
  originalByteLength: 0,
  truncated: false,
}

function observationText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    // Circular and otherwise non-serializable reasons still get a stable bounded diagnostic shape.
    return Object.prototype.toString.call(value)
  }
}

export function toBoundedObservationText(value: unknown, maximumByteLength: number): BoundedObservationText {
  if (value === null || value === undefined) return { ...EMPTY_OBSERVATION_TEXT }
  const text = observationText(value)
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maximumByteLength) {
    return { value: text, originalByteLength: encoded.byteLength, truncated: false }
  }

  let end = maximumByteLength
  // WHATWG's canonical label is utf-8; the lint rule's Node-only utf8 preference does not apply to TextDecoder.
  // eslint-disable-next-line unicorn/text-encoding-identifier-case
  const decoder = new TextDecoder("utf-8", { fatal: true })
  while (end > 0) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        originalByteLength: encoded.byteLength,
        truncated: true,
      }
    } catch {
      end -= 1
    }
  }
  return { value: "", originalByteLength: encoded.byteLength, truncated: true }
}

export function createDefaultGoawaySnapshotSource(): GoawaySnapshotSource {
  let frozen = false
  return {
    freezeAtTerminal() {
      if (frozen) throw new Error("default GOAWAY snapshot source was frozen more than once")
      frozen = true
      return {
        snapshot: {
          availability: "not-observed-before-snapshot",
          events: [],
          protocolViolation: { availability: "none" },
        },
        operationLease: null,
      }
    },
  }
}

export function createLocalTerminationCommitPort(source: GoawaySnapshotSource = createDefaultGoawaySnapshotSource()): Http2TerminationCommitPort {
  let committed = false
  return {
    trySetTransportTermination(build) {
      if (committed) return false
      committed = true
      const { snapshot } = source.freezeAtTerminal()
      build(snapshot)
      return true
    },
  }
}

export interface Http2TerminationRecorder {
  observeHeaders(streamId: number | null): void
  observeTrailers(): void
  observePhysicalClose(): void
  recordEnd(rstCode: number | null): boolean
  recordError(error: unknown, rstCode: number | null): boolean
  recordCloseBeforeEnd(error: unknown, rstCode: number | null): boolean
  recordLocalCancel(source: "body-cancel" | "post-response-signal-abort" | "other-local", reason: unknown, rstCode: number | null): boolean
}

interface RecorderOptions {
  commitPort: Http2TerminationCommitPort
  onTermination?: (snapshot: TransportTerminationSnapshot) => void
  now?: () => number
}

interface TerminalInput {
  signal: TransportTerminationSnapshot["firstObservedSignal"]
  rstCode: number | null
  error?: unknown
  localCancelSource?: TransportTerminationSnapshot["localCancel"]["source"]
  localCancelReason?: unknown
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  return (error as { code?: unknown }).code
}

function errorMessage(error: unknown): unknown {
  if (error instanceof Error) return error.message
  return error
}

function freezeSnapshot(snapshot: TransportTerminationSnapshot): TransportTerminationSnapshot {
  Object.freeze(snapshot.error.code)
  Object.freeze(snapshot.error.message)
  Object.freeze(snapshot.error)
  Object.freeze(snapshot.localCancel.reason)
  Object.freeze(snapshot.localCancel)
  if (snapshot.goaway.availability === "observed-before-snapshot") {
    for (const event of snapshot.goaway.events) {
      Object.freeze(event.opaqueDataLength)
      if ("reason" in event.evidence) Object.freeze(event.evidence.reason)
      Object.freeze(event.evidence)
      Object.freeze(event)
    }
  }
  if ("reason" in snapshot.goaway.protocolViolation) Object.freeze(snapshot.goaway.protocolViolation.reason)
  Object.freeze(snapshot.goaway.protocolViolation)
  Object.freeze(snapshot.goaway.events)
  Object.freeze(snapshot.goaway)
  return Object.freeze(snapshot)
}

export function createHttp2TerminationRecorder(options: RecorderOptions): Http2TerminationRecorder {
  let headersReceived = false
  let streamId: number | null = null
  let trailers: ObservationAtSnapshot = "not-observed-before-snapshot"
  let physicalClose: ObservationAtSnapshot = "not-observed-before-snapshot"

  const commit = (input: TerminalInput): boolean => {
    let committedSnapshot: TransportTerminationSnapshot | undefined
    const committed = options.commitPort.trySetTransportTermination((goaway) => {
      const snapshot: TransportTerminationSnapshot = {
        schemaVersion: 1,
        firstObservedSignal: input.signal,
        terminalEpochMs: (options.now ?? Date.now)(),
        headersReceived,
        streamId,
        rstCode: input.rstCode,
        error: {
          code: toBoundedObservationText(input.error === undefined ? null : errorCode(input.error), 128),
          message: toBoundedObservationText(input.error === undefined ? null : errorMessage(input.error), 1_024),
        },
        localCancel: {
          source: input.localCancelSource ?? null,
          reason: toBoundedObservationText(input.localCancelReason, 1_024),
        },
        trailers,
        physicalClose,
        goaway,
      }
      committedSnapshot = freezeSnapshot(snapshot)
      return committedSnapshot
    })
    if (!committed) return false
    if (committedSnapshot === undefined) throw new Error("HTTP/2 termination commit port accepted without invoking its builder")
    try {
      options.onTermination?.(committedSnapshot)
    } catch {
      // Observation is diagnostic-only: observer failure must never replace consumer termination.
    }
    return true
  }

  return {
    observeHeaders(id) {
      headersReceived = true
      streamId = id
    },
    observeTrailers() {
      trailers = "observed-before-snapshot"
    },
    observePhysicalClose() {
      physicalClose = "observed-before-snapshot"
    },
    recordEnd(rstCode) {
      return commit({ signal: "end", rstCode })
    },
    recordError(error, rstCode) {
      return commit({ signal: "error", error, rstCode })
    },
    recordCloseBeforeEnd(error, rstCode) {
      return commit({ signal: "close-before-end", error, rstCode })
    },
    recordLocalCancel(source, reason, rstCode) {
      return commit({ signal: "local-cancel", localCancelSource: source, localCancelReason: errorMessage(reason), rstCode })
    },
  }
}
