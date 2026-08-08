/**
 * Single source of truth for request lifecycle classification and query filtering.
 *
 * Lifecycle partitions and verdict filters were previously defined independently across History
 * readers, stats, SQL, and the search sidecar adapter. Duplicating them risks silent divergence
 * whenever a state or filter is added — see memory `fix-all-comparison-sites`. This module owns the
 * active-state partition, mutually exclusive verdict bucket, and `state` ∩ `success` query semantics.
 *
 * The three partitions (do NOT conflate them — they are different subsets):
 *  - ACTIVE          = { pending, executing, streaming }        — in-flight; the Live lane owns these.
 *  - TERMINAL        = complement of ACTIVE                       — { completed, failed, aborted, interrupted }.
 *  - NON-SUCCESS-TERMINAL = TERMINAL minus `completed`           — { failed, aborted, interrupted }. This
 *    third partition (reaper `FAILURE_WHERE`, request.ts:813) is SEMANTICALLY distinct and is NOT
 *    exported here; it must never be substituted for TERMINAL (which includes `completed`).
 */

import type {
  //
  QueryOptions,
  RequestLifecycleState,
} from "./core-types"

/**
 * The ONE authoritative list of active (non-terminal, in-flight) lifecycle states. Every other
 * active/terminal partition in the codebase derives from this — add a new active state HERE only.
 */
export const ACTIVE_STATES = ["pending", "executing", "streaming"] as const

/** Set form of {@link ACTIVE_STATES} for O(1) membership — the shape history/queries.ts consumes. */
export const NON_TERMINAL_STATES: ReadonlySet<RequestLifecycleState> = new Set(ACTIVE_STATES)

/** Whether a lifecycle state is active (in-flight). */
export function isActiveState(state: RequestLifecycleState): boolean {
  return NON_TERMINAL_STATES.has(state)
}

/**
 * Whether a lifecycle state is terminal (completed/failed/aborted/interrupted) — the COMPLEMENT of
 * {@link isActiveState}. This is the FULL terminal set (INCLUDES `completed`); do not confuse it with
 * the non-success-terminal subset used by the reaper's failure bucket (see module header).
 */
export function isTerminalState(state: RequestLifecycleState): boolean {
  return !isActiveState(state)
}

/** The one request-verdict bucket a summary belongs to. */
export type RequestBucket = "success" | "failure" | "aborted" | "interrupted" | "none"

/**
 * Assign a request to exactly one verdict bucket. The lifecycle verdict is authoritative; the
 * upstream response flag is only a fallback for legacy summaries that carry no lifecycle state.
 */
export function requestBucket(summary: { state?: RequestLifecycleState; responseSuccess?: boolean }): RequestBucket {
  switch (summary.state) {
    case "completed": {
      return "success"
    }
    case "failed": {
      return "failure"
    }
    case "aborted": {
      return "aborted"
    }
    case "interrupted": {
      return "interrupted"
    }
    case "pending":
    case "executing":
    case "streaming": {
      return "none"
    }
    case undefined: {
      if (summary.responseSuccess === true) return "success"
      if (summary.responseSuccess === false) return "failure"
      return "none"
    }
    default: {
      summary.state satisfies never
      return "none"
    }
  }
}

/**
 * Resolve the intersection of the exact `state` predicate and the coarse `success` predicate.
 * `undefined` means no lifecycle filter; an empty array means the predicates conflict and match
 * nothing. Callers must preserve that distinction rather than sending `[]` to an API where it
 * means “all states”.
 */
export function lifecycleStatesForQuery(options: Pick<QueryOptions, "state" | "success">): ReadonlyArray<RequestLifecycleState> | undefined {
  let successState: RequestLifecycleState | undefined
  if (options.success === true) successState = "completed"
  if (options.success === false) successState = "failed"
  if (options.state !== undefined && successState !== undefined && options.state !== successState) return []
  if (options.state !== undefined) return [options.state]
  return successState === undefined ? undefined : [successState]
}

/** Apply the public lifecycle filters to an in-memory record or summary. */
export function matchesLifecycleQuery(
  summary: { state?: RequestLifecycleState; responseSuccess?: boolean },
  options: Pick<QueryOptions, "state" | "success">,
): boolean {
  if (options.state !== undefined && summary.state !== options.state) return false
  if (options.success === undefined) return true
  return requestBucket(summary) === (options.success ? "success" : "failure")
}
