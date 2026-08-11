import consola from "consola"

import { getHistoryStartupDeadlineMs } from "./startup-deadline-config"
import { initHistory } from "./state"
import { peekHistoryPersistenceRuntime } from "./worker/registry"

// The knob itself lives in a leaf module so the config layer can write it without importing this one — see startup-deadline-config.ts. Re-exported here so callers still have a single startup-deadline surface.
export {
  //
  getHistoryStartupDeadlineMs,
  HISTORY_STARTUP_DEADLINE_MS,
  MAX_HISTORY_STARTUP_DEADLINE_MS,
  setHistoryStartupDeadlineMs,
} from "./startup-deadline-config"

/**
 * Why a deadline exists at all.
 *
 * The Worker's restart budget rate-limits startup retries but deliberately does not cap them: a retryable startup error (spec's transient set — `SQLITE_BUSY`/`SQLITE_LOCKED`/`SQLITE_IOERR`) may well clear on attempt N+1, and turning "tried N times" into a permanent fatal would make a temporary fault unrecoverable for the lifetime of the process (the cap Batch 2a briefly had was withdrawn by user ruling on 2026-08-09 for exactly that reason). So the budget is right and the missing piece is elsewhere: SOMEONE has to decide when the process as a whole stops waiting, and that is the party that owns process startup, not the runtime.
 *
 * Without this, a peer holding the semantic write lock indefinitely leaves the process neither serving nor exiting — spec §8.1 forbids listening before History is ready, and the retry loop never terminates — which replaces a loud `exit 1` with a silent hang that no supervisor can act on.
 */

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
export async function initHistoryWithinStartupDeadline(enable: boolean, deadlineMs: number = getHistoryStartupDeadlineMs()): Promise<void> {
  // Disabling History does no I/O and cannot hang; a deadline there would only add a timer to every startup that runs without History.
  if (!enable || deadlineMs <= 0) {
    await initHistory(enable)
    return
  }

  const bringUp = initHistory(enable)
  let deadlineFired = false
  // The bring-up outlives a LOST race, and its eventual failure would then surface as an unhandled rejection racing the caller's exit path — reporting the wrong error at the wrong layer. This handler exists for that case only: when the race was still open, `Promise.race` hands the very same rejection to the caller, and logging it here too would claim a deadline had been reported when none had.
  void bringUp.catch((error: unknown) => {
    if (!deadlineFired) return
    consola.error("[history] bring-up failed after the startup deadline had already been reported:", error)
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineFired = true
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
