/**
 * Single source of truth for the request-lifecycle-state PARTITION (active vs terminal).
 *
 * The lifecycle has three overlapping partitions that were previously defined independently in
 * ≥3 places (history/queries.ts `NON_TERMINAL_STATES`, history/sqlite/reaper.ts `ACTIVE_STATUSES`,
 * and context/request.ts's inlined non-success predicate). Duplicating them risks silent
 * misclassification the moment a new active state is added — see memory `fix-all-comparison-sites`.
 * This module owns the ACTIVE set as the ONE source; the other two partitions are derived here.
 *
 * The three partitions (do NOT conflate them — they are different subsets):
 *  - ACTIVE          = { pending, executing, streaming }        — in-flight; the Live lane owns these.
 *  - TERMINAL        = complement of ACTIVE                       — { completed, failed, aborted, interrupted }.
 *  - NON-SUCCESS-TERMINAL = TERMINAL minus `completed`           — { failed, aborted, interrupted }. This
 *    third partition (reaper `FAILURE_WHERE`, request.ts:813) is SEMANTICALLY distinct and is NOT
 *    exported here; it must never be substituted for TERMINAL (which includes `completed`).
 */

import type { RequestLifecycleState } from "./types"

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
