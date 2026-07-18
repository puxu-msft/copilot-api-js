/**
 * Primary-only generation coordinator used during the P6 cutover.
 *
 * The coordinator owns candidate topology and recovery ancestry, but it has no sink capability and
 * performs no winner race. P7 extends this same owner with hedging; until then, exactly one candidate
 * is active at a time and buffered recovery replaces its failed parent with a child candidate.
 */

import type {
  //
  CandidateHandle,
  CandidateRole,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import type {
  //
  CandidateReady,
  CandidateRuntime,
} from "./candidate"

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
  cancel(reason: string): Promise<void>
}

/** Create a single-generation, primary-only coordinator. */
export function createGenerationCoordinator<TProcessor>(input: CreateGenerationCoordinatorInput<TProcessor>): GenerationCoordinator<TProcessor> {
  const deliveryIdentity = input.deliveryIdentity ?? Symbol("generationDelivery")
  const runtimes = new Map<CandidateHandle, CandidateRuntime<TProcessor>>()
  let primaryStarted = false
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
