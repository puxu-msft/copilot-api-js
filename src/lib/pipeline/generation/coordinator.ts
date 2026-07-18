/**
 * Generation coordinator for primary/recovery topology and P7 candidate races.
 *
 * The coordinator owns candidate topology and recovery ancestry, but it has no sink capability and
 * owns candidate topology and winner selection but has no downstream sink capability. Buffered
 * recovery replaces its failed parent with a child candidate; hedging keeps siblings active until
 * one produces a complete client-format block.
 */

import type {
  //
  CandidateHandle,
  CandidateRole,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ClientFrame } from "~/lib/pipeline/types"

import { withRejectionObserver } from "~/lib/transport/crash-safety"

import type {
  //
  CandidateReady,
  CandidateRuntime,
} from "./candidate"
import type { CandidateResponseSession } from "./candidate-response-session"

import {
  //
  type CandidateProbeOutcome,
  probeCandidateResponse,
} from "./candidate-race"

export interface CoordinatorCandidateInput {
  readonly role: CandidateRole
  readonly parentCandidate?: CandidateHandle
  readonly env: RequestEnvelope
}

export interface CoordinatedCandidate<TProcessor> extends CandidateReady<TProcessor> {
  readonly role: CandidateRole
  readonly deliveryIdentity: symbol
}

export interface CreateGenerationCoordinatorInput<TProcessor> {
  readonly env: RequestEnvelope
  /** Identity of the handler-owned downstream session; the coordinator never recreates it. */
  readonly deliveryIdentity?: symbol
  readonly createCandidate: (input: CoordinatorCandidateInput) => CandidateRuntime<TProcessor>
}

export interface GenerationCoordinator<TProcessor> {
  readonly deliveryIdentity: symbol
  runPrimary(): Promise<CoordinatedCandidate<TProcessor>>
  runRecovery(parent: CoordinatedCandidate<TProcessor>, reason: string, env?: RequestEnvelope): Promise<CoordinatedCandidate<TProcessor>>
  runHedge(env?: RequestEnvelope): Promise<CoordinatedCandidate<TProcessor>>
  raceReadyCandidates(candidates: ReadonlyArray<CoordinatedCandidate<TProcessor>>): Promise<HedgeWinner<TProcessor>>
  racePrimaryWithDelayedHedge(input: {
    primary: CoordinatedCandidate<TProcessor>
    delayMs: number
    hedgeEnv?: RequestEnvelope
    startHedge?: () => Promise<CoordinatedCandidate<TProcessor>>
  }): Promise<HedgeRaceResult<TProcessor>>
  cancel(reason: string): Promise<void>
}

export interface HedgeWinner<TProcessor> {
  readonly candidate: CoordinatedCandidate<TProcessor>
  readonly bufferedFrames: ReadonlyArray<ClientFrame>
  readonly liveFrames: AsyncIterable<ClientFrame>
  readonly loserCleanup: Promise<void>
}

export type HedgeRaceResult<TProcessor> =
  | ({ readonly kind: "winner" } & HedgeWinner<TProcessor>)
  | { readonly kind: "terminal"; readonly candidate: CoordinatedCandidate<TProcessor>; readonly bufferedFrames: ReadonlyArray<ClientFrame> }
  | { readonly kind: "failure"; readonly error: unknown }

/** Create a single-generation, primary-only coordinator. */
export function createGenerationCoordinator<TProcessor>(input: CreateGenerationCoordinatorInput<TProcessor>): GenerationCoordinator<TProcessor> {
  const deliveryIdentity = input.deliveryIdentity ?? Symbol("generationDelivery")
  const runtimes = new Map<CandidateHandle, CandidateRuntime<TProcessor>>()
  let primaryStarted = false
  let hedgeStarted = false
  let raceStarted = false
  let active: CandidateRuntime<TProcessor> | undefined
  let cancelledReason: string | undefined

  const start = async (candidateInput: CoordinatorCandidateInput): Promise<CoordinatedCandidate<TProcessor>> => {
    if (cancelledReason !== undefined) throw new Error(cancelledReason)
    const runtime = input.createCandidate(candidateInput)
    runtimes.set(runtime.handle, runtime)
    active = runtime
    try {
      const ready = await runtime.run()
      return { ...ready, role: runtime.role, deliveryIdentity }
    } catch (error) {
      if (active === runtime) active = undefined
      throw error
    }
  }

  return {
    deliveryIdentity,

    runPrimary() {
      if (primaryStarted) throw new Error("[generation-coordinator] primary already started")
      primaryStarted = true
      return start({ role: "primary", env: input.env })
    },

    async runRecovery(parent, reason, env = parent.env) {
      const parentRuntime = runtimes.get(parent.candidate)
      if (!parentRuntime) throw new Error("[generation-coordinator] recovery parent is not owned by this coordinator")
      await parent.settleDispatch({ verdict: "discarded", reason, retryNextStrategy: "buffered-retry" })
      parentRuntime.settle({ verdict: "failed", reason })
      if (active === parentRuntime) active = undefined
      return start({ role: "recovery", parentCandidate: parent.candidate, env })
    },

    runHedge(env = input.env) {
      if (hedgeStarted) throw new Error("[generation-coordinator] hedge already started")
      hedgeStarted = true
      return start({ role: "hedge", env })
    },

    async raceReadyCandidates(candidates) {
      if (raceStarted) throw new Error("[generation-coordinator] candidate race already started")
      raceStarted = true
      if (candidates.length === 0) throw new Error("[generation-coordinator] no candidates to race")
      const pending = new Map<number, Promise<{ index: number; outcome: CandidateProbeOutcome<CoordinatedCandidate<TProcessor>> }>>()
      for (const [index, candidate] of candidates.entries()) {
        const session = asCandidateResponseSession(candidate.processor)
        pending.set(
          index,
          probeCandidateResponse({ candidate, session, upstream: candidate.upstream }).then((outcome) => ({ index, outcome })),
        )
      }
      const failures: Array<unknown> = []
      while (pending.size > 0) {
        // Promise.race observes the iterable in candidate order. If boundaries settle in the same
        // microtask turn, the primary/earlier candidate therefore wins deterministically.
        const settled = await Promise.race(pending.values())
        pending.delete(settled.index)
        const { outcome } = settled
        if (outcome.kind === "boundary") {
          const winner = outcome.candidate
          const loserCleanup = withRejectionObserver(
            Promise.allSettled(
              candidates.flatMap((candidate, index) => {
                if (candidate.candidate === winner.candidate) return []
                const runtime = runtimes.get(candidate.candidate)
                const tasks: Array<Promise<unknown>> = []
                if (runtime) tasks.push(runtime.cancel("lost hedge race"))
                const probe = pending.get(index)
                if (probe) tasks.push(probe.then((entry) => (entry.outcome.kind === "boundary" ? entry.outcome.close() : undefined)))
                return tasks
              }),
            ).then((results) => {
              const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
              if (errors.length > 0) throw new AggregateError(errors, "One or more hedge losers failed to quiesce")
            }),
          )
          return { candidate: winner, bufferedFrames: outcome.bufferedFrames, liveFrames: outcome.liveFrames, loserCleanup }
        }
        const runtime = runtimes.get(outcome.candidate.candidate)
        runtime?.settle({ verdict: "failed", reason: outcome.kind === "failure" ? "response-failure" : "terminal-without-boundary" })
        if (outcome.kind === "failure") failures.push(outcome.error)
      }
      throw new AggregateError(failures, "No generation candidate produced a complete client block")
    },

    async racePrimaryWithDelayedHedge({ primary, delayMs, hedgeEnv, startHedge }) {
      if (raceStarted) throw new Error("[generation-coordinator] candidate race already started")
      raceStarted = true
      const primaryProbe = probeCandidateResponse({ candidate: primary, session: asCandidateResponseSession(primary.processor), upstream: primary.upstream })
      const threshold = delayWithCancel(delayMs)
      const first = await Promise.race([
        primaryProbe.then((outcome) => ({ kind: "primary" as const, outcome })),
        threshold.promise.then(() => ({ kind: "threshold" as const })),
      ])
      if (first.kind === "primary") {
        threshold.cancel()
        if (first.outcome.kind === "boundary") {
          return {
            kind: "winner",
            candidate: primary,
            bufferedFrames: first.outcome.bufferedFrames,
            liveFrames: first.outcome.liveFrames,
            loserCleanup: Promise.resolve(),
          }
        }
        if (first.outcome.kind === "terminal") return { kind: "terminal", candidate: primary, bufferedFrames: first.outcome.bufferedFrames }
        return { kind: "failure", error: first.outcome.error }
      }

      let hedge: CoordinatedCandidate<TProcessor>
      try {
        hedge = await (startHedge ? startHedge() : this.runHedge(hedgeEnv))
      } catch (error) {
        await runtimes.get(primary.candidate)?.cancel("hedge-start-failed")
        await primaryProbe
        return { kind: "failure", error }
      }
      const hedgeProbe = probeCandidateResponse({ candidate: hedge, session: asCandidateResponseSession(hedge.processor), upstream: hedge.upstream })
      return raceProbePromises({ candidates: [primary, hedge], probes: [primaryProbe, hedgeProbe], runtimes })
    },

    async cancel(reason) {
      cancelledReason ??= reason
      const candidates = [...runtimes.values()]
      const results = await Promise.allSettled(candidates.map((runtime) => runtime.cancel(reason)))
      active = undefined
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length > 0) throw new AggregateError(errors, "One or more generation candidates failed to cancel")
    },
  }
}

async function raceProbePromises<TProcessor>(input: {
  candidates: ReadonlyArray<CoordinatedCandidate<TProcessor>>
  probes: ReadonlyArray<Promise<CandidateProbeOutcome<CoordinatedCandidate<TProcessor>>>>
  runtimes: Map<CandidateHandle, CandidateRuntime<TProcessor>>
}): Promise<HedgeRaceResult<TProcessor>> {
  const pending = new Map(input.probes.map((probe, index) => [index, probe.then((outcome) => ({ index, outcome }))]))
  const failures: Array<unknown> = []
  let firstTerminal: Extract<CandidateProbeOutcome<CoordinatedCandidate<TProcessor>>, { kind: "terminal" }> | undefined
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values())
    pending.delete(settled.index)
    const { outcome } = settled
    if (outcome.kind === "boundary") {
      const loserCleanup = observeLoserCleanup(input.candidates, pending, outcome.candidate, input.runtimes)
      return {
        kind: "winner",
        candidate: outcome.candidate,
        bufferedFrames: outcome.bufferedFrames,
        liveFrames: outcome.liveFrames,
        loserCleanup,
      }
    }
    if (outcome.kind === "failure") {
      input.runtimes.get(outcome.candidate.candidate)?.settle({ verdict: "failed", reason: "response-failure" })
      failures.push(outcome.error)
    } else {
      firstTerminal ??= outcome
    }
  }
  if (firstTerminal) return { kind: "terminal", candidate: firstTerminal.candidate, bufferedFrames: firstTerminal.bufferedFrames }
  return { kind: "failure", error: new AggregateError(failures, "No generation candidate produced a complete client block") }
}

function observeLoserCleanup<TProcessor>(
  candidates: ReadonlyArray<CoordinatedCandidate<TProcessor>>,
  pending: Map<number, Promise<{ index: number; outcome: CandidateProbeOutcome<CoordinatedCandidate<TProcessor>> }>>,
  winner: CoordinatedCandidate<TProcessor>,
  runtimes: Map<CandidateHandle, CandidateRuntime<TProcessor>>,
): Promise<void> {
  return withRejectionObserver(
    Promise.allSettled(
      candidates.flatMap((candidate, index) => {
        if (candidate.candidate === winner.candidate) return []
        const runtime = runtimes.get(candidate.candidate)
        const tasks: Array<Promise<unknown>> = []
        if (runtime) tasks.push(runtime.cancel("lost hedge race"))
        const probe = pending.get(index)
        if (probe) tasks.push(probe.then((entry) => (entry.outcome.kind === "boundary" ? entry.outcome.close() : undefined)))
        return tasks
      }),
    ).then((results) => {
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length > 0) throw new AggregateError(errors, "One or more hedge losers failed to quiesce")
    }),
  )
}

function delayWithCancel(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
    timer = setTimeout(done, Math.max(0, ms))
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
      resolve()
    },
  }
}

function asCandidateResponseSession(value: unknown): CandidateResponseSession {
  if (!value || typeof value !== "object" || !("processor" in value) || !("responseOpts" in value) || !("boundary" in value)) {
    throw new Error("[generation-coordinator] hedge race requires CandidateResponseSession processors")
  }
  return value as CandidateResponseSession
}
