/**
 * Who may write a diagnostic about a dispatch, and when.
 *
 * A dispatch has many asynchronous producers — data, headers, error and close listeners on an h2 stream, plus the termination recorder. They normally all describe the same story. Forced teardown breaks that: once we have given up on a stream and started tearing it down, a listener that fires afterwards is describing a corpse, and its report would contradict the forced-disposal record that the operator will actually read.
 *
 * So writes are gated on an explicit state rather than on hope:
 *
 * - `open` — the ordinary case. Any producer may write.
 * - `forcing` — forced teardown has begun. Ordinary producers are silenced; only the owner channel returned by {@link DispatchDiagnosticSink.beginForcing} may write, so the forced-disposal narrative is written by exactly one author with no interleaving.
 * - `sealed` — the record for this dispatch is final. Nobody may write, including the owner.
 *
 * The transitions are one-way and idempotent-safe: a late `close` firing during `forcing` or after `sealed` is silently dropped rather than corrupting the account of what happened.
 */
export type DispatchSinkState = "open" | "forcing" | "sealed"

/** What a caller records; deliberately the shape `recordGenerationDispatchDiagnostic` already accepts. */
export interface SinkDiagnostic {
  kind: string
  severity: "info" | "warning" | "error"
  message?: string
  data?: unknown
}

/** The single writer permitted while a forced teardown is in progress. */
export interface ForcingOwnerChannel {
  /** Write as the forced-teardown author. Rejected once {@link seal} has run. */
  write: (diagnostic: SinkDiagnostic) => void
  /** Finalise the record. Every later write, from any producer, is dropped. */
  seal: () => void
}

export interface DispatchDiagnosticSink {
  readonly state: DispatchSinkState
  /** Ordinary producer write. Dropped unless the sink is `open`. */
  write: (diagnostic: SinkDiagnostic) => void
  /**
   * Atomically claim authorship of forced teardown.
   *
   * Returns `null` if the sink is not `open` — meaning someone else is already forcing, or the record is sealed. The caller must treat `null` as "not mine to narrate" and do nothing, which is what keeps two concurrent forcers from writing an interleaved story.
   */
  beginForcing: () => ForcingOwnerChannel | null
}

/**
 * Build a sink over `record`.
 *
 * `record` is invoked only when the state permits it, so a caller cannot accidentally write past a seal by holding onto the raw recorder.
 */
export function createDispatchDiagnosticSink(record: (diagnostic: SinkDiagnostic) => void): DispatchDiagnosticSink {
  let state: DispatchSinkState = "open"

  return {
    get state(): DispatchSinkState {
      return state
    },

    write(diagnostic: SinkDiagnostic): void {
      if (state !== "open") return
      record(diagnostic)
    },

    beginForcing(): ForcingOwnerChannel | null {
      // The check and the transition are one synchronous step, so a second caller can never also see `open`.
      if (state !== "open") return null
      state = "forcing"

      return {
        write(diagnostic: SinkDiagnostic): void {
          // The owner may write only during its own forcing window; after `seal` even it is finished.
          if (state !== "forcing") return
          record(diagnostic)
        },
        seal(): void {
          state = "sealed"
        },
      }
    },
  }
}
