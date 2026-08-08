import type {
  //
  CandidateHandle,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  ClientSink,
  ResponseFailureDiagnostics,
  ResponseFailureSource,
  ResponseOutcome,
  UpstreamStream,
} from "~/lib/pipeline/types"

/** Candidate-local state remains owned by its codec session and is never projected by this contract. */
export interface RecoveryAttemptSnapshot {
  readonly acc: object
}

export interface RecoveryAttemptDisposition {
  /** Promotes this exact candidate after Task #4 atomically publishes its frames. */
  commit(): Promise<void>
  /** Closes this candidate through the driver without selecting it as a winner. */
  discard(): Promise<void>
}

interface RecoveryAttemptBase<TSnapshot extends RecoveryAttemptSnapshot> {
  readonly primaryError: unknown
  readonly frames: ReadonlyArray<ClientFrame>
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly disposition: RecoveryAttemptDisposition
  readonly snapshot?: TSnapshot
}

interface RecoveryAttemptFailure<TSnapshot extends RecoveryAttemptSnapshot> extends RecoveryAttemptBase<TSnapshot> {
  readonly recoveryError: unknown
  readonly source?: ResponseFailureSource
  readonly diagnostics?: ResponseFailureDiagnostics
}

/** Exhaustive, authority-free result of one isolated recovery attempt. */
export type RecoveryAttemptEvaluationResult<TSnapshot extends RecoveryAttemptSnapshot, TResponse> =
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "complete"; readonly response: TResponse })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "upstream-error" })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "response-stream-failure"; readonly source: ResponseFailureSource })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "truncation" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "settled-abort" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "refusal" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "unrepairable-tool-input"; readonly tool: string })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "delivery-finished" })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "unexpected-throw"; readonly snapshotError?: unknown })

export interface DirectRecoveryAccumulator {
  readonly model: string
  readonly stopReason?: string
  readonly sawMessageStop: boolean
  readonly streamError?: { readonly type: string; readonly message: string }
  readonly contentBlocks: ReadonlyArray<unknown>
}

export interface DirectRecoverySnapshot extends RecoveryAttemptSnapshot {
  readonly acc: DirectRecoveryAccumulator
  readonly unrepairableToolInput?: string
}

export interface DirectRecoveryDriver<TSnapshot extends DirectRecoverySnapshot> {
  runResponseSink(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink, opts: { readonly responseMode: "evaluate" }): Promise<ResponseOutcome>
  getCandidateSnapshot(upstream: UpstreamStream): TSnapshot
  getCandidateIdentity(upstream: UpstreamStream): { readonly candidate: CandidateHandle; readonly dispatch: DispatchHandle }
  commitConsumedCandidate(upstream: UpstreamStream): Promise<void>
  discardConsumedCandidate(upstream: UpstreamStream): Promise<void>
}

export interface EvaluateDirectRecoveryInput<TSnapshot extends DirectRecoverySnapshot, TResponse> {
  readonly driver: DirectRecoveryDriver<TSnapshot>
  readonly upstream: UpstreamStream
  readonly env: RequestEnvelope
  readonly primaryError: unknown
  readonly responseFromSnapshot: (snapshot: TSnapshot) => TResponse
  readonly isContentlessRefusal: (snapshot: TSnapshot) => boolean
}

/** Drives an isolated candidate into a collector that has `write` but no terminal capability. */
export async function evaluateDirectRecovery<TSnapshot extends DirectRecoverySnapshot, TResponse>(
  input: EvaluateDirectRecoveryInput<TSnapshot, TResponse>,
): Promise<RecoveryAttemptEvaluationResult<TSnapshot, TResponse>> {
  const frames: Array<ClientFrame> = []
  const collector: ClientSink = {
    async write(frame) {
      frames.push(frame)
    },
  }
  const { candidate, dispatch } = input.driver.getCandidateIdentity(input.upstream)
  let dispositionState: "pending" | "committing" | "discarding" | "committed" | "discarded" | "failed-clean" = "pending"
  const beginDisposition = (next: "committing" | "discarding"): void => {
    if (dispositionState !== "pending") throw new Error(`[recovery-evaluator] evaluation result disposition is ${dispositionState}`)
    dispositionState = next
  }
  const disposition: RecoveryAttemptDisposition = {
    async commit() {
      beginDisposition("committing")
      try {
        await input.driver.commitConsumedCandidate(input.upstream)
        dispositionState = "committed"
      } catch (error) {
        dispositionState = "failed-clean"
        throw error
      }
    },
    async discard() {
      beginDisposition("discarding")
      try {
        await input.driver.discardConsumedCandidate(input.upstream)
        dispositionState = "discarded"
      } catch (error) {
        dispositionState = "failed-clean"
        throw error
      }
    },
  }
  const base = (snapshot?: TSnapshot) => ({ primaryError: input.primaryError, frames, candidate, dispatch, disposition, ...(snapshot && { snapshot }) })

  let outcome: ResponseOutcome
  try {
    outcome = await input.driver.runResponseSink(input.upstream, input.env, collector, { responseMode: "evaluate" })
  } catch (recoveryError) {
    return { ...base(), kind: "unexpected-throw", recoveryError }
  }

  let snapshot: TSnapshot
  try {
    snapshot = input.driver.getCandidateSnapshot(input.upstream)
  } catch (snapshotError) {
    return { ...base(), kind: "unexpected-throw", recoveryError: outcome, snapshotError }
  }

  switch (outcome.kind) {
    case "complete": {
      if (snapshot.acc.streamError)
        return {
          ...base(snapshot),
          kind: "upstream-error",
          recoveryError: new Error(`${snapshot.acc.streamError.type}: ${snapshot.acc.streamError.message}`),
        }
      if (input.isContentlessRefusal(snapshot)) return { ...base(snapshot), kind: "refusal" }
      const tool = snapshot.unrepairableToolInput
      if (tool !== undefined) return { ...base(snapshot), kind: "unrepairable-tool-input", tool }
      if (!snapshot.acc.sawMessageStop)
        return { ...base(snapshot), kind: "truncation", recoveryError: new Error("upstream stream truncated: closed without message_stop") }
      return { ...base(snapshot), kind: "complete", response: input.responseFromSnapshot(snapshot) }
    }
    case "stream-error": {
      return {
        ...base(snapshot),
        kind: "response-stream-failure",
        recoveryError: outcome.error,
        source: outcome.source,
        ...(outcome.diagnostics && { diagnostics: outcome.diagnostics }),
      }
    }
    case "settled-abort": {
      return { ...base(snapshot), kind: "settled-abort" }
    }
    case "delivery-finished": {
      return { ...base(snapshot), kind: "delivery-finished" }
    }
    default: {
      outcome satisfies never
      throw new Error("unreachable recovery outcome")
    }
  }
}
