/**
 * Candidate-local physical dispatch scheduler.
 *
 * This module owns the topology inside one candidate: every prepare/admission/open cycle gets
 * a fresh explicit DispatchHandle. It deliberately does not consume response frames, choose a
 * generation winner, own downstream delivery, or create recovery candidates.
 */

import type {
  //
  CandidateHandle,
  CandidateRole,
  CandidateVerdict,
  DispatchHandle,
  DispatchVerdict,
} from "~/lib/context/model-operation-record"
import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PhysicalTransport,
  PhysicalTransportResponse,
  PreparedRequest,
  TransportDispatchOptions,
  UpstreamDispatchLifecycle,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { UpstreamAdmissionController } from "~/lib/transport/admission-controller"

import { classifyError } from "~/lib/error"
import {
  //
  abortableDelay,
  OperationCancelledError,
} from "~/lib/util/abortable-delay"

import type { GenerationBudget } from "./generation-budget"

export type DispatchReason = "initial" | "reactive-retry" | "rate-limit-retry" | "ws-fallback"

export interface DispatchSettlement {
  verdict: DispatchVerdict
  reason?: string
  error?: unknown
  waitMs?: number
  retryNextStrategy?: string
}

export interface DispatchRecordingPort {
  beginCandidate(input: { role: CandidateRole; parentCandidate?: CandidateHandle; metadata?: { recoveryReason?: string } }): CandidateHandle
  settleCandidate(candidate: CandidateHandle, input: { verdict: CandidateVerdict; reason?: string }): void
  beginDispatch(input: {
    candidate: CandidateHandle
    reason: DispatchReason
    strategy?: string
    wire: PreparedRequest
    forceHttp: boolean
    env: RequestEnvelope
  }): DispatchHandle
  recordAdmission(dispatch: DispatchHandle, admission: { admittedAt: number; queueWaitMs: number }): void
  recordOpened(dispatch: DispatchHandle, response: PhysicalTransportResponse): void
  settleDispatch(dispatch: DispatchHandle, input: DispatchSettlement): void
}

export type SemanticRetryDecision =
  | {
      kind: "retry"
      env: RequestEnvelope
      reason: string
      waitMs?: number
      onResolved?: (env: RequestEnvelope) => void | Promise<void>
    }
  | { kind: "fail" }

export interface SemanticRetryInput {
  candidate: CandidateHandle
  dispatch: DispatchHandle
  env: RequestEnvelope
  error: ApiError
  rawError: unknown
  dispatchNumber: number
}

export interface CreateDispatchSchedulerInput {
  prepareWire: (env: RequestEnvelope, input: { reason: DispatchReason; forceHttp: boolean }) => PreparedRequest
  open: PhysicalTransport["open"]
  admission: UpstreamAdmissionController
  recording: DispatchRecordingPort
  decideRetry: (input: SemanticRetryInput) => SemanticRetryDecision | Promise<SemanticRetryDecision>
  /** Hard generation-candidate guard across fallback, 429 and semantic retries. */
  maxDispatches?: number
  monotonicNow?: () => number
  generationBudget?: GenerationBudget
}

export interface ScheduledDispatch {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly reason: DispatchReason
  readonly env: RequestEnvelope
  readonly wire: PreparedRequest
  readonly dispatchedAtMonotonic: number
  readonly upstream: UpstreamStream
  readonly lifecycle: UpstreamDispatchLifecycle
}

export interface DispatchScheduler {
  run(input: { candidate: CandidateHandle; env: RequestEnvelope; signal: AbortSignal; initialStrategy?: string }): Promise<ScheduledDispatch>
  /** Dispose the one ready-but-unconsumed dispatch while preserving the caller's terminal settlement. */
  disposeActiveWithSettlement(input: DispatchSettlement): Promise<void>
  cancelActive(reason: string): Promise<void>
  /** Assert a fully consumed response no longer occupies an active scheduler slot. */
  assertNoActiveReadyDispatch(dispatch: DispatchHandle): void
  settle(dispatch: DispatchHandle, input: DispatchSettlement): Promise<void>
}

interface ActiveDispatch {
  lifecycle: UpstreamDispatchLifecycle
}

/** Create a scheduler for exactly one candidate runtime. */
export function createDispatchScheduler(input: CreateDispatchSchedulerInput): DispatchScheduler {
  const active = new Map<DispatchHandle, ActiveDispatch>()
  const settled = new Set<DispatchHandle>()
  const cleanup = new Map<DispatchHandle, Promise<void>>()
  const maxDispatches = input.maxDispatches ?? 16
  const monotonicNow = input.monotonicNow ?? performance.now.bind(performance)

  const recordSettlement = (dispatch: DispatchHandle, settlement: DispatchSettlement): void => {
    if (settled.has(dispatch)) return
    settled.add(dispatch)
    input.recording.settleDispatch(dispatch, settlement)
  }

  const disposeDispatch = (
    dispatch: DispatchHandle,
    lifecycle: UpstreamDispatchLifecycle,
    settlement: DispatchSettlement,
    cancelFirst: boolean,
  ): Promise<void> => {
    const pending = cleanup.get(dispatch)
    if (pending) return pending
    const task = (async () => {
      let disposalError: unknown
      if (cancelFirst) {
        try {
          lifecycle.cancel(settlement.reason)
        } catch (error) {
          disposalError = error
        }
      }
      try {
        await lifecycle.dispose(settlement.reason)
      } catch (error) {
        disposalError = error
      }
      try {
        await lifecycle.quiesced
      } catch (error) {
        disposalError ??= error
      }
      active.delete(dispatch)
      recordSettlement(dispatch, {
        ...settlement,
        ...(disposalError !== undefined && settlement.error === undefined && { error: disposalError }),
      })
      if (disposalError !== undefined) throw asError(disposalError)
    })()
    cleanup.set(dispatch, task)
    return task
  }

  const scheduler: DispatchScheduler = {
    async run({ candidate, env, signal, initialStrategy }) {
      let current = env
      let reason: DispatchReason = "initial"
      let strategy: string | undefined = initialStrategy
      let forceHttp = false
      let acceptedResolution: ((env: RequestEnvelope) => void | Promise<void>) | undefined
      let dispatchNumber = 0

      for (;;) {
        throwIfAborted(signal)
        if (dispatchNumber >= maxDispatches) throw new Error(`[dispatch-scheduler] dispatch budget exhausted (${maxDispatches})`)
        dispatchNumber++
        const dispatchBudget = input.generationBudget?.reserveDispatch()
        const wire = input.prepareWire(current, { reason, forceHttp })
        const dispatch = input.recording.beginDispatch({ candidate, reason, ...(strategy !== undefined && { strategy }), wire, forceHttp, env: current })
        const model = current.model.id || "unknown"
        let admission
        try {
          admission = await input.admission.acquire({ model, candidateId: candidate, dispatchId: dispatch, signal })
          throwIfAborted(signal)
        } catch (error) {
          dispatchBudget?.release()
          recordSettlement(dispatch, {
            verdict: signal.aborted ? "cancelled" : "failed",
            reason: signal.aborted ? abortReason(signal, "candidate-cancelled") : "admission-failed",
            error,
          })
          throw error
        }
        input.recording.recordAdmission(dispatch, admission)

        let response: PhysicalTransportResponse
        const dispatchedAtMonotonic = monotonicNow()
        try {
          const options: TransportDispatchOptions = { signal, ...(forceHttp && { forceHttp: true }) }
          response = await input.open(wire, current, options)
        } catch (error) {
          dispatchBudget?.release()
          recordSettlement(dispatch, { verdict: "failed", reason: "physical-open-threw", error })
          throw new Error("[dispatch-scheduler] PhysicalTransport.open() threw instead of returning failed-open", { cause: error })
        }
        input.recording.recordOpened(dispatch, response)
        active.set(dispatch, { lifecycle: response.lifecycle })
        void response.lifecycle.quiesced.then(
          () => dispatchBudget?.release(),
          () => dispatchBudget?.release(),
        )

        if (signal.aborted) {
          await disposeDispatch(dispatch, response.lifecycle, { verdict: "cancelled", reason: abortReason(signal, "candidate-cancelled") }, true)
          throw abortError(signal)
        }

        if (response.kind === "stream" || response.kind === "json") {
          dispatchBudget?.release()
          input.admission.observe({ model, status: 200, completedAt: Date.now() })
          await acceptedResolution?.(current)
          return {
            candidate,
            dispatch,
            reason,
            env: current,
            wire,
            dispatchedAtMonotonic,
            upstream:
              response.kind === "stream" ?
                response.upstream
              : {
                  headers: response.headers,
                  nonStream: response.body,
                  lifecycle: response.lifecycle,
                  frames: emptyFrames(),
                },
            lifecycle: response.lifecycle,
          }
        }

        if (response.kind === "fallback-before-first-event") {
          input.admission.observe({ model, completedAt: Date.now() })
          await disposeDispatch(
            dispatch,
            response.lifecycle,
            { verdict: "discarded", reason: "ws-fallback", error: response.error, retryNextStrategy: "ws-fallback" },
            false,
          )
          forceHttp = true
          reason = "ws-fallback"
          strategy = "ws-fallback"
          continue
        }

        const apiError = classifyError(response.error)
        const rateLimited = apiError.status === 429 || apiError.type === "rate_limited" || apiError.type === "upstream_rate_limited"
        const admissionDecision = input.admission.observe({
          model,
          status: apiError.status,
          ...(rateLimited && { rateLimited: true }),
          ...(apiError.retryAfter !== undefined && { retryAfterMs: apiError.retryAfter * 1000 }),
          completedAt: Date.now(),
        })
        if (rateLimited && admissionDecision.kind === "retry") {
          await disposeDispatch(
            dispatch,
            response.lifecycle,
            {
              verdict: "discarded",
              reason: "rate-limit-retry",
              error: response.error,
              waitMs: admissionDecision.retryAfterMs,
              retryNextStrategy: "rate-limit-retry",
            },
            false,
          )
          reason = "rate-limit-retry"
          strategy = "rate-limit-retry"
          continue
        }

        const semantic = await input.decideRetry({ candidate, dispatch, env: current, error: apiError, rawError: response.error, dispatchNumber })
        if (semantic.kind === "fail") {
          await disposeDispatch(dispatch, response.lifecycle, { verdict: "failed", reason: "failed-open", error: response.error }, false)
          throw asError(response.error)
        }

        await disposeDispatch(dispatch, response.lifecycle, { verdict: "discarded", reason: `reactive-retry:${semantic.reason}`, error: response.error }, false)
        current = semantic.env
        acceptedResolution = semantic.onResolved
        reason = "reactive-retry"
        strategy = semantic.reason
        if (semantic.waitMs) await abortableDelay(semantic.waitMs, signal)
      }
    },

    async disposeActiveWithSettlement(settlement) {
      const entries = [...active.entries()].filter(([dispatch]) => !settled.has(dispatch))
      if (entries.length !== 1) throw new Error(`[dispatch-scheduler] expected exactly one active ready dispatch, found ${entries.length}`)
      const results = await Promise.allSettled(entries.map(([dispatch, owned]) => disposeDispatch(dispatch, owned.lifecycle, settlement, true)))
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length > 0)
        throw new AggregateError(
          errors.map((error) => asError(error)),
          "Ready dispatch disposal failed",
        )
    },

    async cancelActive(reason) {
      const entries = [...active.entries()].filter(([dispatch]) => !settled.has(dispatch))
      const cancellationErrors: Array<unknown> = []
      for (const [, owned] of entries) {
        try {
          owned.lifecycle.cancel(reason)
        } catch (error) {
          cancellationErrors.push(error)
        }
      }
      const disposalResults = await Promise.allSettled(
        entries.map(([dispatch, owned]) => disposeDispatch(dispatch, owned.lifecycle, { verdict: "cancelled", reason }, false)),
      )
      for (const result of disposalResults) if (result.status === "rejected") cancellationErrors.push(result.reason)
      if (cancellationErrors.length > 0)
        throw new AggregateError(
          cancellationErrors.map((error) => asError(error)),
          "One or more candidate dispatches failed to quiesce",
        )
    },

    assertNoActiveReadyDispatch(dispatch) {
      if (active.has(dispatch)) throw new Error(`[dispatch-scheduler] consumed dispatch ${dispatch} remains active`)
    },

    async settle(dispatch, settlement) {
      if (settled.has(dispatch)) return
      const owned = active.get(dispatch)
      let quiesceError: unknown
      if (owned) {
        try {
          await owned.lifecycle.quiesced
        } catch (error) {
          quiesceError = error
        } finally {
          active.delete(dispatch)
        }
      }
      if (quiesceError !== undefined) {
        recordSettlement(dispatch, {
          verdict: "failed",
          reason: "settlement-quiesce-failed",
          ...(settlement.error === undefined && { error: quiesceError }),
        })
        throw asError(quiesceError)
      }
      recordSettlement(dispatch, settlement)
    },
  }

  return scheduler
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortReason(signal: AbortSignal, fallback: string): string {
  if (signal.reason instanceof Error) return signal.reason.message
  if (typeof signal.reason === "string") return signal.reason
  return fallback
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new OperationCancelledError(abortReason(signal, "candidate cancelled"))
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error), { cause: error })
}

function emptyFrames(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true as const, value: undefined as never }) }
    },
  }
}
