/**
 * Per-request store of candidate lineage — RFC §6, slice C2.2.
 *
 * `[hard]` This slice **records** and nothing acts on the record yet. That is a deliberate staging
 * decision, not an oversight: `deliveryAuthority` transfer is C2.3's and implementing it here would
 * put two owners on the one invariant that matters most (at most one `active` writer per request).
 * The distinction from dead state is that this registry has named consumers (C2.3's authority
 * machine, History's `CandidateHistoryDiagnostic` projection) and a read API from day one.
 *
 * Keyed on the `CandidateHandle` the recorder already mints, so this is a side table on the existing
 * observability model rather than a parallel one.
 */

import type {
  //
  CandidateHandle,
  CandidateRole,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import type {
  //
  CandidateTranslationLineage,
  LineageCause,
} from "./lineage"
import type { SegmentId } from "./types"

import { createCandidateLineage } from "./lineage"
import { bridgePairFor } from "./pair-identity"
import { resolvePairPolicy } from "./policy-resolver"

/**
 * Why a candidate may end up with no lineage. Both non-recorded arms are **stored**, not discarded:
 * "this candidate has no policy" is itself a fact a diagnostic needs, and swallowing it here would
 * make an absent lineage indistinguishable from a candidate that was never registered.
 */
export type CandidateLineageOutcome =
  | Readonly<{ kind: "recorded"; lineage: CandidateTranslationLineage }>
  /** Not an Anthropic ↔ Responses request (RFC §2), or built outside the HTTP ingress so it carries no config snapshot. */
  | Readonly<{ kind: "out-of-scope"; reason: "not-a-bridge-pair" | "no-config-snapshot" }>
  /** RFC §6.2: matching only an invalid rule is not the same as matching nothing, and must never become a default-looking policy. */
  | Readonly<{ kind: "config-error"; matchedRuleId: string; code: "rule-invalid" }>

/**
 * `recovery` is this repository's name for RFC §6's **pre-commit** fallback — `runRecovery` discards
 * the parent's ready upstream and settles it `failed`, so the client received nothing. RFC's
 * post-commit fallback has no role today (C2.3 owns that gap), which is why this is a widening
 * translation rather than a rename.
 */
const CAUSE_BY_ROLE: Readonly<Record<CandidateRole, LineageCause>> = {
  primary: "primary",
  hedge: "hedge",
  recovery: "fallback",
  continuation: "continuation",
}

export type RegisterCandidateInput = Readonly<{
  candidate: CandidateHandle
  role: CandidateRole
  env: RequestEnvelope
  segmentId: SegmentId
  parentCandidate?: CandidateHandle
  parentSegmentId?: SegmentId
}>

export interface CandidateLineageRegistry {
  /** Resolve and store this candidate's lineage. Called once per candidate, at creation. */
  register(input: RegisterCandidateInput): CandidateLineageOutcome
  outcomeOf(candidate: CandidateHandle): CandidateLineageOutcome | undefined
  lineageOf(candidate: CandidateHandle): CandidateTranslationLineage | undefined
  /** Every recorded lineage, in registration order — the order candidates were created. */
  recorded(): ReadonlyArray<CandidateTranslationLineage>
}

export function createCandidateLineageRegistry(): CandidateLineageRegistry {
  const outcomes = new Map<CandidateHandle, CandidateLineageOutcome>()

  const resolve = (input: RegisterCandidateInput): CandidateLineageOutcome => {
    const snapshot = input.env.request.translationConfigSnapshot
    if (snapshot === undefined) return { kind: "out-of-scope", reason: "no-config-snapshot" }

    const pair = bridgePairFor(input.env)
    if (pair === undefined) return { kind: "out-of-scope", reason: "not-a-bridge-pair" }

    const resolution = resolvePairPolicy(snapshot, pair.source, pair.target)
    if (resolution.kind === "config-error") return resolution

    return {
      kind: "recorded",
      lineage: createCandidateLineage({
        candidateId: input.candidate,
        segmentId: input.segmentId,
        cause: CAUSE_BY_ROLE[input.role],
        policy: resolution.policy,
        ...(input.parentCandidate !== undefined && { parentCandidateId: input.parentCandidate }),
        ...(input.parentSegmentId !== undefined && { parentSegmentId: input.parentSegmentId }),
      }),
    }
  }

  return {
    register(input) {
      // Re-registering would silently replace a candidate's frozen policy, which is the one thing RFC §6 forbids: an ancestor's policy is never rewritten.
      const existing = outcomes.get(input.candidate)
      if (existing) throw new Error(`[candidate-lineage] candidate ${input.candidate} is already registered`)

      const outcome = resolve(input)
      outcomes.set(input.candidate, outcome)
      return outcome
    },

    outcomeOf(candidate) {
      return outcomes.get(candidate)
    },

    lineageOf(candidate) {
      const outcome = outcomes.get(candidate)
      return outcome?.kind === "recorded" ? outcome.lineage : undefined
    },

    recorded() {
      return [...outcomes.values()].flatMap((outcome) => (outcome.kind === "recorded" ? [outcome.lineage] : []))
    },
  }
}
