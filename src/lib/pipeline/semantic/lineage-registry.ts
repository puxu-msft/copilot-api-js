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
import type { RequestContext } from "~/lib/context/types"
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
import { asSegmentId } from "./types"

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
  parentCandidate?: CandidateHandle
}>

/**
 * Segments are derived from the candidate, not allocated by a second counter, because **today they
 * are 1:1**. RFC §6 has a fallback or continuation boundary create a new candidate *and* a new ledger
 * segment in the same act, and §6's ledger rules forbid two hedge candidates from sharing a mutable
 * ledger — so every candidate owns exactly one segment and no segment spans two candidates.
 *
 * `causeStartsNewSegment` is therefore about **boundaries**, not about allocation: a hedge has its own
 * segment (every racer does) without declaring a boundary, because a race has no boundary to declare.
 *
 * If a boundary ever needs to land *without* opening a candidate, this derivation is the thing that
 * breaks, and it breaks loudly — two boundaries in one candidate would collide on one id rather than
 * silently interleave.
 */
function segmentOf(candidate: CandidateHandle): SegmentId {
  return asSegmentId(`seg:${candidate}`)
}

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
        segmentId: segmentOf(input.candidate),
        cause: CAUSE_BY_ROLE[input.role],
        policy: resolution.policy,
        ...(input.parentCandidate !== undefined && { parentCandidateId: input.parentCandidate, parentSegmentId: segmentOf(input.parentCandidate) }),
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

/**
 * One registry per request, keyed on the request's `RequestContext` identity.
 *
 * **Why a side table rather than a field on `RequestContext` or `RequestScope`.** Both would work,
 * and `RequestScope.translationConfigSnapshot` is precedent for the latter — but `src/lib/context/`
 * currently has no import edge into `~/lib/pipeline` at all, and putting a semantic-bridge type in
 * the core context types would open one. That is the same argument that moved this wiring off the
 * generation coordinator: a protocol-neutral component should not learn the bridge's vocabulary just
 * to carry its data.
 *
 * `RequestContext` is the right key rather than the coordinator, because the lineage is per-REQUEST:
 * `createDriverCoordinator` runs more than once for a request whose continuation leg opens a new
 * coordinator, and all of those legs share one ctx and must share one lineage record. Keying on the
 * coordinator would silently split a continuation chain into unrelated halves.
 */
const byRequestContext = new WeakMap<RequestContext, CandidateLineageRegistry>()

export function candidateLineageFor(ctx: RequestContext): CandidateLineageRegistry {
  const existing = byRequestContext.get(ctx)
  if (existing) return existing

  const registry = createCandidateLineageRegistry()
  byRequestContext.set(ctx, registry)
  return registry
}
