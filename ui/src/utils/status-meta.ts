/**
 * Single source of truth for request lifecycle status presentation.
 *
 * Every consumer (Activity list rows, Detail meta/strip, Dashboard outcomes,
 * status pills) derives color / icon / label from THIS table — never from a
 * parallel if-chain. Adding a new lifecycle state means adding one row here;
 * the `satisfies Record<RequestLifecycleState, …>` constraint + the
 * exhaustiveness unit test make a missing entry a compile/test failure rather
 * than a silent visual regression (the root cause of the old aborted/
 * interrupted "degrade to pending" bug).
 *
 * `color` values are Vuetify theme color tokens. `completed/failed/streaming/
 * executing/secondary` are built-in; `aborted`/`interrupted` are registered as
 * first-class theme colors in plugins/vuetify.ts (with variations + the
 * --aborted/--interrupted shorthand vars in variables.css).
 */

import type { RequestLifecycleState } from "@/types"

export interface StatusMeta {
  /** Vuetify theme color token. */
  color: string
  /** MDI icon name. */
  icon: string
  /** Human label. */
  label: string
  /** Whether this is a non-terminal (active) state. */
  active: boolean
}

export const STATUS_META = {
  pending: { color: "secondary", icon: "mdi-clock-outline", label: "Pending", active: true },
  executing: { color: "warning", icon: "mdi-progress-clock", label: "Executing", active: true },
  streaming: { color: "info", icon: "mdi-waveform", label: "Streaming", active: true },
  completed: { color: "success", icon: "mdi-check-circle", label: "Completed", active: false },
  failed: { color: "error", icon: "mdi-close-circle", label: "Failed", active: false },
  aborted: { color: "aborted", icon: "mdi-link-off", label: "Aborted", active: false },
  interrupted: { color: "interrupted", icon: "mdi-alert-octagon", label: "Interrupted", active: false },
} satisfies Record<RequestLifecycleState, StatusMeta>

/** Fallback used when an entry has no resolvable state (defensive). */
const FALLBACK: StatusMeta = STATUS_META.pending

/** Look up presentation metadata for a lifecycle state (accepts raw strings; unknown → fallback). */
export function statusMeta(state: string | undefined): StatusMeta {
  if (state && state in STATUS_META) return STATUS_META[state as RequestLifecycleState]
  return FALLBACK
}

/** All lifecycle states, in lifecycle order — for filter dropdowns etc. */
export const LIFECYCLE_STATES = Object.keys(STATUS_META) as Array<RequestLifecycleState>
