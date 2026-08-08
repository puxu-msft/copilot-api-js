/**
 * One branch-local generation candidate.
 *
 * The runtime opens physical dispatches through a candidate-local scheduler and hands a successful
 * upstream plus a fresh processor to the future coordinator. It never reads frames, chooses a winner,
 * owns delivery timers, or writes a sink. Consequently the processor remains paused at its initial
 * boundary until the coordinator starts consuming it in P6-T2.
 */

import type {
  //
  CandidateHandle,
  CandidateRole,
  CandidateVerdict,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { UpstreamStream } from "~/lib/pipeline/types"

import { combineAbortSignals } from "~/lib/stream"
import { OperationCancelledError } from "~/lib/util/abortable-delay"

import type {
  //
  DispatchRecordingPort,
  DispatchScheduler,
  DispatchSettlement,
} from "./dispatch-scheduler"

export interface RecoveryCandidateRequest {
  readonly role: "recovery"
  readonly parentCandidate: CandidateHandle
  readonly env: RequestEnvelope
  readonly reason: string
}

export interface CandidateReady<TProcessor> {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly wire: import("~/lib/pipeline/types").PreparedRequest
  readonly dispatchedAtMonotonic: number
  readonly upstream: UpstreamStream
  readonly processor: TProcessor
  settleDispatch(input: DispatchSettlement): Promise<void>
}

export interface CandidateRuntime<TProcessor> {
  readonly handle: CandidateHandle
  readonly role: CandidateRole
  run(): Promise<CandidateReady<TProcessor>>
  /** Dispose a ready parent without changing its candidate verdict. */
  disposeReadyWithSettlement(input: DispatchSettlement): Promise<void>
  cancel(reason: string): Promise<void>
  settle(input: { verdict: CandidateVerdict; reason?: string }): void
  recovery(reason: string): RecoveryCandidateRequest
}

export interface CreateCandidateRuntimeInput<TProcessor> {
  readonly role: CandidateRole
  readonly parentCandidate?: CandidateHandle
  readonly metadata?: { recoveryReason?: string }
  /** Strategy attached to this candidate's initial physical dispatch. */
  readonly initialStrategy?: string
  readonly env: RequestEnvelope
  /** Fork request/response state only after the canonical candidate handle exists. */
  readonly forkEnv?: (candidate: CandidateHandle) => RequestEnvelope
  readonly recording: DispatchRecordingPort
  readonly scheduler: DispatchScheduler
  readonly createProcessor: (input: { candidate: CandidateHandle; dispatch: DispatchHandle; env: RequestEnvelope; upstream: UpstreamStream }) => TProcessor
}

/** Create a single-use candidate runtime. Buffered recovery is represented only as a child-candidate request. */
export function createCandidateRuntime<TProcessor>(input: CreateCandidateRuntimeInput<TProcessor>): CandidateRuntime<TProcessor> {
  const handle = input.recording.beginCandidate({
    role: input.role,
    ...(input.parentCandidate && { parentCandidate: input.parentCandidate }),
    ...(input.metadata !== undefined && { metadata: input.metadata }),
  })
  const candidateEnv = input.forkEnv?.(handle) ?? input.env
  const controller = new AbortController()
  const signal = combineAbortSignals(controller.signal, candidateEnv.ctx.operationSignal) ?? controller.signal
  let started = false
  let settled = false
  let latestEnv = candidateEnv
  let runPromise: Promise<CandidateReady<TProcessor>> | undefined

  const settleCandidate = (settlement: { verdict: CandidateVerdict; reason?: string }): void => {
    if (settled) return
    settled = true
    input.recording.settleCandidate(handle, settlement)
  }

  return {
    handle,
    role: input.role,

    run() {
      if (started) throw new Error("[candidate-runtime] candidate already started")
      started = true
      runPromise = (async () => {
        try {
          const ready = await input.scheduler.run({
            candidate: handle,
            env: latestEnv,
            signal,
            ...(input.initialStrategy !== undefined && { initialStrategy: input.initialStrategy }),
          })
          latestEnv = ready.env
          return {
            candidate: handle,
            dispatch: ready.dispatch,
            env: ready.env,
            wire: ready.wire,
            dispatchedAtMonotonic: ready.dispatchedAtMonotonic,
            upstream: ready.upstream,
            processor: input.createProcessor({ candidate: handle, dispatch: ready.dispatch, env: ready.env, upstream: ready.upstream }),
            settleDispatch: async (settlement) => {
              await input.scheduler.settle(ready.dispatch, settlement)
              input.scheduler.assertNoActiveReadyDispatch(ready.dispatch)
            },
          }
        } catch (error) {
          if (signal.aborted) settleCandidate({ verdict: "cancelled", reason: signal.reason instanceof Error ? signal.reason.message : "candidate cancelled" })
          else settleCandidate({ verdict: "failed", reason: error instanceof Error ? error.message : "candidate failed" })
          throw error
        }
      })()
      return runPromise
    },

    async disposeReadyWithSettlement(settlement) {
      await input.scheduler.disposeActiveWithSettlement(settlement)
    },

    async cancel(reason) {
      if (!controller.signal.aborted) controller.abort(new OperationCancelledError(reason))
      let cleanupFailed = false
      let cleanupError: unknown
      try {
        await input.scheduler.cancelActive(reason)
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
      }
      if (runPromise) {
        try {
          await runPromise
        } catch {
          // The original run promise remains rejected for its caller. This second observer only
          // joins the expected cancellation path so cancel cannot return before late-open cleanup.
        }
      }
      settleCandidate({ verdict: "cancelled", reason })
      if (cleanupFailed) throw cleanupError
    },

    settle(settlement) {
      settleCandidate(settlement)
    },

    recovery(reason) {
      return { role: "recovery", parentCandidate: handle, env: latestEnv, reason }
    },
  }
}
