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

import type { CandidateHandle } from "~/lib/context/model-operation-record"

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
 * **Deliberately not an alias of `CandidateRole`** — that equation was tried and disproved. Three
 * values do line up (`primary`, `hedge`, `continuation`), but the two enums diverge at both ends, and
 * each divergence is load-bearing:
 *
 * - `retry` was **removed** from RFC §6's original five. It names nothing at this granularity: a
 *   retry is a new **dispatch** under the *same* candidate (`dispatch-scheduler.ts` calls
 *   `beginDispatch` inside a `for(;;)` loop keyed by one `candidate`), so its counterpart is
 *   `DispatchReason`, one level down. Offering it here invites a writer to record an event that
 *   cannot occur.
 * - `fallback` is **broader than** the coordinator's `recovery` role, not a rename of it.
 *   `runRecovery` (`coordinator.ts:212`) discards the parent's ready upstream and settles it `failed`
 *   — the client has received nothing — which is precisely RFC §6's *pre-commit* fallback. RFC's
 *   *post-commit* fallback, a model switch after irrevocable client bytes, has **no candidate role
 *   today**; the only post-commit hand-off the coordinator can express is `runContinuation`, whose
 *   parent settles `continued`. So `recovery` covers one half of `fallback`.
 *
 * What RFC §3.4 asserts survives intact: `fallback` and `continuation` are different kinds and do not
 * share an ID namespace. They look alike (both fork a candidate off a parent) but their parent
 * disposition is opposite: a fallback's parent is void, a continuation's parent is an
 * already-delivered prefix.
 */
export type LineageCause = "primary" | "hedge" | "fallback" | "continuation"

/**
 * `candidateId` reuses the **existing branded handle** rather than declaring a second id namespace of
 * plain strings. RFC §6 names it abstractly, but the repository already mints it: `beginCandidate`
 * (`dispatch-scheduler.ts:50`) issues the `CandidateHandle` that History V3 projects as `candidateId`
 * (`history/v3/projection.ts:281`). A parallel `string` id here would be the "normalized-key bug
 * recurring at many comparison sites" shape — and worse, `string` lets a dispatchId, a segmentId or a
 * candidateId be swapped for one another with no diagnostic.
 *
 * **There is deliberately no `dispatchId`.** This record is per-candidate and is born with the
 * candidate, at which point no dispatch exists yet; a candidate then owns *N* dispatches, since
 * `dispatch-scheduler.ts` retries by looping `beginDispatch` under one candidate. Pinning one
 * dispatch here would be a lie for every retried candidate while still reading as authoritative. The
 * granularity is not arbitrary: policy is frozen at candidate boundaries and a retry may not re-read
 * hot config (RFC §6), so every dispatch under one candidate shares this record verbatim. Records
 * that ARE minted after a dispatch exists — `TranslationObservation`, `AuthorityIdentity` — carry
 * their own `dispatchId`, known at the moment they are made.
 *
 * `parentCandidateId` is a **mirrored foreign key, not a second source of truth**: the recorder owns
 * the parent edge (`beginCandidate({ parentCandidate })`), and History V3 already projects it as
 * `parentCandidateId`. It is restated here so a lineage value is self-contained where the recorder is
 * not reachable; if the two ever disagree, the recorder wins.
 *
 * Genuinely new on this record — the reason it exists at all — are `segmentId`, `parentSegmentId`,
 * `configSnapshotId`, `policy` and `deliveryAuthority`. Everything else is a key into the existing
 * observability model.
 */
export type CandidateTranslationLineage = Readonly<{
  candidateId: CandidateHandle
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
