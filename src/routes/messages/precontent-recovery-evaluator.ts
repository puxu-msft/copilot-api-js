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

interface RecoveryAttemptBase<TSnapshot extends RecoveryAttemptSnapshot> {
  readonly primaryError: unknown
  readonly frames: ReadonlyArray<ClientFrame>
  readonly snapshot: TSnapshot
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
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "stream-error"; readonly source: ResponseFailureSource })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "truncation" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "settled-abort" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "refusal" })
  | (RecoveryAttemptBase<TSnapshot> & { readonly kind: "unrepairable-tool-input"; readonly tool: string })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "delivery-finished" })
  | (RecoveryAttemptFailure<TSnapshot> & { readonly kind: "unexpected-throw" })

export interface DirectRecoveryAccumulator {
  readonly model: string
  readonly stopReason?: string
  readonly sawMessageStop: boolean
  readonly streamError?: { readonly type: string; readonly message: string }
  readonly contentBlocks: ReadonlyArray<unknown>
}

export interface DirectRecoverySnapshot extends RecoveryAttemptSnapshot {
  readonly acc: DirectRecoveryAccumulator
}

export interface DirectRecoveryDriver<TSnapshot extends DirectRecoverySnapshot> {
  runResponseSink(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink): Promise<ResponseOutcome>
  getCandidateSnapshot(upstream: UpstreamStream): TSnapshot
}

export interface EvaluateDirectRecoveryInput<TSnapshot extends DirectRecoverySnapshot, TResponse> {
  readonly driver: DirectRecoveryDriver<TSnapshot>
  readonly upstream: UpstreamStream
  readonly env: RequestEnvelope
  readonly primaryError: unknown
  readonly responseFromSnapshot: (snapshot: TSnapshot) => TResponse
  readonly isContentlessRefusal: (snapshot: TSnapshot) => boolean
  readonly unrepairableToolInput: () => string | undefined
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
  const base = (snapshot: TSnapshot) => ({ primaryError: input.primaryError, frames, snapshot })

  try {
    const outcome = await input.driver.runResponseSink(input.upstream, input.env, collector)
    const snapshot = input.driver.getCandidateSnapshot(input.upstream)
    switch (outcome.kind) {
      case "complete": {
        if (snapshot.acc.streamError)
          return {
            ...base(snapshot),
            kind: "upstream-error",
            recoveryError: new Error(`${snapshot.acc.streamError.type}: ${snapshot.acc.streamError.message}`),
          }
        if (input.isContentlessRefusal(snapshot)) return { ...base(snapshot), kind: "refusal" }
        const tool = input.unrepairableToolInput()
        if (tool !== undefined) return { ...base(snapshot), kind: "unrepairable-tool-input", tool }
        if (!snapshot.acc.sawMessageStop)
          return { ...base(snapshot), kind: "truncation", recoveryError: new Error("upstream stream truncated: closed without message_stop") }
        return { ...base(snapshot), kind: "complete", response: input.responseFromSnapshot(snapshot) }
      }
      case "stream-error": {
        return {
          ...base(snapshot),
          kind: "stream-error",
          recoveryError: outcome.error,
          source: outcome.source,
          ...(outcome.diagnostics && { diagnostics: outcome.diagnostics }),
        }
      }
      case "settled-abort": {
        return { ...base(snapshot), kind: "settled-abort" }
      }
      case "delivery-finished": {
        return { ...base(snapshot), kind: "delivery-finished", recoveryError: input.primaryError }
      }
      default: {
        outcome satisfies never
        throw new Error("unreachable recovery outcome")
      }
    }
  } catch (recoveryError) {
    const snapshot = input.driver.getCandidateSnapshot(input.upstream)
    return { ...base(snapshot), kind: "unexpected-throw", recoveryError }
  }
}
