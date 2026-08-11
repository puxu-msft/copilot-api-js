import consola from "consola"

/**
 * The startup-deadline knob, in a module with no project-internal imports.
 *
 * It is separate from `startup-deadline.ts` for one structural reason: the config apply pass has to write it, and `startup-deadline.ts` reaches `history/state` (it has to — it drives the bring-up). An import from `config.ts` into that module therefore drags the config layer into History's import cycle, which the SCC ratchet catches and the project's standing rule ("don't let the core SCC grow sideways") forbids. A leaf holding just the value has no such reach — `consola` is external and cannot put this file in a cycle.
 */

/**
 * How long process startup waits for History to become usable before giving up. **0 means wait forever, and that is the default** (user ruling, 2026-08-10, after a restart died on the 30s value this held before).
 *
 * The reasoning that produced 30s was sound about the wrong quantity. It compared the deadline against a *healthy* bring-up (schema reconcile plus journal recovery, tens of milliseconds) and against the restart budget's 30s backoff cap, and concluded that overshooting both meant a persistent failure. What it did not price in is the case that actually fires it: a **graceful-restart overlap**, where the successor opens History while the predecessor is still draining. Since the drain is deliberately unbounded — it ends when the last accepted request ends, or when an operator presses Ctrl+C a second time — the wait the successor faces has **no upper bound derivable at build time**. Any fixed value is therefore guaranteed to be wrong for some legitimate restart, and the observed failure says exactly that: `consecutive startup failures: 0, no retry scheduled` — nothing had failed, the Worker simply had not finished yet.
 *
 * Refusing to serve is the correct behaviour when History is genuinely broken; the retry loop and its logs are what surface that. Turning "still waiting" into `exit 1` converts a slow restart into a dead server, which is strictly worse than the silent-hang risk the deadline was added to prevent — an operator can see a process that has not come up, and can always set this knob to a positive value to get the old behaviour back.
 */
export const HISTORY_STARTUP_DEADLINE_MS = 0

/**
 * Largest delay `setTimeout` can actually hold (2^31 - 1 ms, ~24.9 days).
 *
 * Beyond it the runtime does not wait longer — it wraps the duration to 1ms and fires almost immediately, with only a `TimeoutOverflowWarning` to show for it. Measured on Bun: `setTimeout(fn, 2147483648)` fired in ~7ms. Applied to a startup deadline that inverts the knob completely: asking to wait 25 days would make every healthy start report a deadline and exit 1.
 */
export const MAX_HISTORY_STARTUP_DEADLINE_MS = 2_147_483_647

/**
 * Configured deadline, fed by `history.startup_deadline_ms` through the config apply pass.
 *
 * A module-local rather than a `state` field, following `setV3PersistRetryConfig`: exactly one consumer reads it, exactly once, before the server listens — a state field plus change listeners would buy nothing, since nothing can usefully react to it after startup has already finished.
 */
let configuredDeadlineMs = HISTORY_STARTUP_DEADLINE_MS

export function setHistoryStartupDeadlineMs(deadlineMs: number): void {
  // Clamp rather than accept-and-invert. The schema rejects out-of-range values before they get here, so this is the second line: a programmatic caller that passes 2^31 is asking to wait a long time, and the one outcome that must never happen is treating that as "give up at once".
  if (deadlineMs > MAX_HISTORY_STARTUP_DEADLINE_MS) {
    consola.warn(
      `[history] startup_deadline_ms=${deadlineMs} exceeds the ${MAX_HISTORY_STARTUP_DEADLINE_MS}ms timer ceiling; clamping to the ceiling (a larger value would wrap and fire almost immediately)`,
    )
    configuredDeadlineMs = MAX_HISTORY_STARTUP_DEADLINE_MS
    return
  }
  configuredDeadlineMs = deadlineMs
}

export function getHistoryStartupDeadlineMs(): number {
  return configuredDeadlineMs
}
