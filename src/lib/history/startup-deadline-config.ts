/**
 * The startup-deadline knob, alone in a module with NO imports.
 *
 * It is separate from `startup-deadline.ts` for one structural reason: the config apply pass has to write it, and `startup-deadline.ts` reaches `history/state` (it has to — it drives the bring-up). An import from `config.ts` into that module therefore drags the config layer into History's import cycle, which the SCC ratchet catches and the project's standing rule ("don't let the core SCC grow sideways") forbids. A leaf holding just the value has no such reach.
 */

/**
 * How long process startup waits for History to become usable before giving up.
 *
 * 30s is far longer than a healthy bring-up (schema reconcile plus journal recovery, measured in tens of milliseconds) and longer than the restart budget's 30s backoff cap, so a deadline hit means the failure persisted across several real attempts rather than that one start was slow.
 */
export const HISTORY_STARTUP_DEADLINE_MS = 30_000

/**
 * Configured deadline, fed by `history.startup_deadline_ms` through the config apply pass.
 *
 * A module-local rather than a `state` field, following `setV3PersistRetryConfig`: exactly one consumer reads it, exactly once, before the server listens — a state field plus change listeners would buy nothing, since nothing can usefully react to it after startup has already finished.
 */
let configuredDeadlineMs = HISTORY_STARTUP_DEADLINE_MS

export function setHistoryStartupDeadlineMs(deadlineMs: number): void {
  configuredDeadlineMs = deadlineMs
}

export function getHistoryStartupDeadlineMs(): number {
  return configuredDeadlineMs
}
