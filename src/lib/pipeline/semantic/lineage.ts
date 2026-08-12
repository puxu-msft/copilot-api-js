/**
 * Candidate lineage — RFC §6.
 *
 * Who is whose descendant, why it exists, and which policy it translates under. Today that
 * information is implicit in the coordinator's settle semantics: you can infer "this was a
 * continuation" from the verdict a parent settled with, but nothing carries it forward, so History
 * cannot say which writer produced which bytes under which policy.
 *
 * `[hard]` This slice **records** lineage and nothing consumes it. The delivery-authority state
 * machine below is transcribed from RFC §6 so the shape is fixed once, but only its initial value is
 * ever produced here — transfer is C2.3's, and implementing it early would put two owners on the
 * one invariant that matters most (at most one `active` writer per request).
 */

import type { CandidateHandle, DispatchHandle } from "~/lib/context/model-operation-record"

import type { PairTranslationPolicy } from "./policy-resolver"
import type { SegmentId } from "./types"

/**
 * Which candidate may write to the client, and how that right moved.
 *
 * `epoch` is what makes a transfer auditable rather than merely observed: an ancestor that handed
 * off keeps `transferred(epoch=N)` and its own partial terminal, while the descendant holds
 * `active(epoch=N+1)`. A boolean "is winner" cannot express that chain, which is why History's
 * winner is a lineage, not a flag.
 */
export type DeliveryAuthorityState =
  | Readonly<{ kind: "uncommitted" }>
  | Readonly<{ kind: "active"; epoch: number }>
  | Readonly<{ kind: "transferred"; epoch: number; cause: "fallback" | "continuation"; toCandidateId: CandidateHandle }>
  | Readonly<{ kind: "terminal"; epoch: number }>
  | Readonly<{ kind: "discarded" }>

/**
 * Why this candidate exists.
 *
 * `fallback` and `continuation` are **different kinds and do not share an ID namespace** (RFC §3.4).
 * They look alike — both make a new candidate off a parent — but their parent disposition is
 * opposite: a fallback's parent is void, a continuation's parent is an already-delivered prefix.
 */
export type LineageCause = "primary" | "retry" | "hedge" | "fallback" | "continuation"

/**
 * `candidateId` / `dispatchId` reuse the **existing branded handles** rather than declaring a second
 * id namespace of plain strings. RFC §6 names these fields abstractly, but the repository already
 * mints them: `beginCandidate` (`dispatch-scheduler.ts:50`) issues the `CandidateHandle` that History
 * V3 projects as `candidateId` (`history/v3/projection.ts:281`). A parallel `string` id here would be
 * the "normalized-key bug recurring at many comparison sites" shape — and worse, `string` lets a
 * dispatchId, a segmentId, or a candidateId be swapped for one another with no diagnostic.
 */
export type CandidateTranslationLineage = Readonly<{
  candidateId: CandidateHandle
  dispatchId: DispatchHandle
  segmentId: SegmentId
  parentCandidateId?: CandidateHandle
  parentSegmentId?: SegmentId
  cause: LineageCause
  configSnapshotId: string
  policy: PairTranslationPolicy
  deliveryAuthority: DeliveryAuthorityState
}>

export type CreateLineageInput = Readonly<{
  candidateId: CandidateHandle
  dispatchId: DispatchHandle
  segmentId: SegmentId
  cause: LineageCause
  policy: PairTranslationPolicy
  parentCandidateId?: CandidateHandle
  parentSegmentId?: SegmentId
}>

/**
 * Record a candidate's lineage. Always born `uncommitted`: authority is granted by the driver at the
 * commit point, never assumed at construction.
 *
 * `configSnapshotId` is taken from the policy rather than passed separately — the policy was itself
 * resolved from that snapshot, so accepting it twice would create two places for them to disagree.
 */
export function createCandidateLineage(input: CreateLineageInput): CandidateTranslationLineage {
  return Object.freeze({
    candidateId: input.candidateId,
    dispatchId: input.dispatchId,
    segmentId: input.segmentId,
    ...(input.parentCandidateId === undefined ? {} : { parentCandidateId: input.parentCandidateId }),
    ...(input.parentSegmentId === undefined ? {} : { parentSegmentId: input.parentSegmentId }),
    cause: input.cause,
    configSnapshotId: input.policy.configSnapshotId,
    policy: input.policy,
    deliveryAuthority: Object.freeze({ kind: "uncommitted" as const }),
  })
}

/**
 * Does this cause start a new boundary segment?
 *
 * `raceReadyCandidates` decides which candidate becomes authoritative; it does **not** create a
 * segment, because a race has no boundary — every racer already has its own. Folding the two would
 * make a hedge look like a fallback in the record.
 */
export function causeStartsNewSegment(cause: LineageCause): boolean {
  return cause === "fallback" || cause === "continuation"
}
