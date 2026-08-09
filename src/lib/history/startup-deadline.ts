import consola from "consola"

import { initHistory } from "./state"
import { peekHistoryPersistenceRuntime } from "./worker/registry"

/**
 * How long process startup waits for History to become usable before giving up.
 *
 * The Worker's restart budget rate-limits startup retries but deliberately does not cap them: a retryable startup error (spec's transient set — `SQLITE_BUSY`/`SQLITE_LOCKED`/`SQLITE_IOERR`) may well clear on attempt N+1, and turning "tried N times" into a permanent fatal would make a temporary fault unrecoverable for the lifetime of the process (the cap Batch 2a briefly had was withdrawn by user ruling on 2026-08-09 for exactly that reason). So the budget is right and the missing piece is elsewhere: SOMEONE has to decide when the process as a whole stops waiting, and that is the party that owns process startup, not the runtime.
 *
 * Without this, a peer holding the semantic write lock indefinitely leaves the process neither serving nor exiting — spec §8.1 forbids listening before History is ready, and the retry loop never terminates — which replaces a loud `exit 1` with a silent hang that no supervisor can act on.
 *
 * 30s is chosen to be far longer than a healthy bring-up (schema reconcile plus journal recovery, measured in tens of milliseconds) and longer than the restart budget's 30s backoff cap, so a deadline hit means the failure has persisted across several real attempts rather than catching one slow start.
 */
export const HISTORY_STARTUP_DEADLINE_MS = 30_000

/**
 * Configured deadline, fed by `history.startup_deadline_ms` through the config apply pass.
 *
 * A module-local value rather than a `state` field, following `setV3PersistRetryConfig`: exactly one consumer reads it, exactly once, before the server listens — a state field plus change listeners would buy nothing, since nobody can usefully react to it after startup has already finished.
 */
let configuredDeadlineMs = HISTORY_STARTUP_DEADLINE_MS

export function setHistoryStartupDeadlineMs(deadlineMs: number): void {
  configuredDeadlineMs = deadlineMs
}

export function getHistoryStartupDeadlineMs(): number {
  return configuredDeadlineMs
}

/**
 * History did not become usable within the startup deadline.
 *
 * Carries the runtime's own retry counters, because "we waited 30s" alone does not distinguish a Worker that is retrying a locked database from one that never got scheduled.
 */
export class HistoryStartupDeadlineError extends Error {
  readonly consecutiveFailures: number
  readonly nextRetryAt: number | undefined

  constructor(deadlineMs: number, consecutiveFailures: number, nextRetryAt: number | undefined) {
    const retry = nextRetryAt === undefined ? "no retry scheduled" : `next retry at ${new Date(nextRetryAt).toISOString()}`
    super(`[history] startup deadline exceeded: History did not become ready within ${deadlineMs}ms (consecutive startup failures: ${consecutiveFailures}, ${retry})`)
    this.name = "HistoryStartupDeadlineError"
    this.consecutiveFailures = consecutiveFailures
    this.nextRetryAt = nextRetryAt
  }
}

/**
 * Bring History up, but give up after `deadlineMs`.
 *
 * IMPORTANT — the caller's obligation on rejection is to END THE PROCESS. Losing this race does not cancel the bring-up: the Worker is still retrying, and `shutdownHistory()` cannot be used to clean up because it queues behind the very transition that is not finishing. A caller that caught this error and carried on would run without History AND without the exit that tells a supervisor something is wrong.
 *
 * `deadlineMs <= 0` disables the deadline (waits forever), which is only appropriate for callers that are not a process entry point.
 */
export async function initHistoryWithinStartupDeadline(enable: boolean, deadlineMs: number = configuredDeadlineMs): Promise<void> {
  // Disabling History does no I/O and cannot hang; a deadline there would only add a timer to every startup that runs without History.
  if (!enable || deadlineMs <= 0) {
    await initHistory(enable)
    return
  }

  const bringUp = initHistory(enable)
  // The bring-up outlives a lost race. Without a handler here its eventual failure would surface as an unhandled rejection racing the caller's exit path, which reports the wrong error at the wrong layer.
  void bringUp.catch((error: unknown) => {
    consola.error("[history] bring-up failed after the startup deadline had already been reported:", error)
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const status = peekHistoryPersistenceRuntime()?.snapshot()
      reject(new HistoryStartupDeadlineError(deadlineMs, status?.consecutiveFailures ?? 0, status?.nextRetryAt))
    }, deadlineMs)
  })

  try {
    await Promise.race([bringUp, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
