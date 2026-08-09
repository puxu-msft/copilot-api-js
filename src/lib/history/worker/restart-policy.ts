/**
 * Restart budget for a crashed History Worker.
 *
 * A crash is recoverable: the main thread still owns every un-ACKed envelope, so the fix
 * is a new Worker plus an ordered replay. What must be bounded is the *rate* — a Worker
 * that dies on every start (bad artifact, exhausted disk) would otherwise become a hot
 * restart loop. Only `fatal` is terminal; this policy governs everything else.
 *
 * The capped exponential is spelled out here rather than reused from the V3 store's
 * commit budget on purpose: importing the store would pull `bun:sqlite` and the
 * compression codec into the MAIN thread's module graph, which is exactly the dependency
 * the write-first migration exists to remove (and which the Batch 6c architecture guard
 * will forbid outright).
 */
export interface HistoryWorkerRestartPolicyOptions {
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly now?: () => number
}

export interface HistoryWorkerRestartDecision {
  readonly consecutiveFailures: number
  readonly delayMs: number
  readonly nextRetryAt: number
}

const DEFAULT_INITIAL_DELAY_MS = 200
const DEFAULT_MAX_DELAY_MS = 30_000

export class HistoryWorkerRestartPolicy {
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly now: () => number
  private failures = 0
  private pendingRetryAt: number | undefined

  constructor(options: HistoryWorkerRestartPolicyOptions = {}) {
    this.initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
    this.now = options.now ?? Date.now
  }

  /**
   * Record one crash and return when the next Worker may be started.
   *
   * There is deliberately NO attempt ceiling: spec §7.1 routes ordinary crashes and
   * retryable startup errors through the automatic restart, and §7.2 reserves the
   * irreversible terminal state for conditions already known to be permanent. Turning "tried
   * N times" into a permanent failure would give up on a condition that may still clear.
   *
   * The consequence is real and is owned elsewhere: a condition that NEVER clears leaves
   * `start()` unsettled forever, and §8.1 keeps the proxy from listening — so whoever owns
   * process startup (Batch 2b) must impose a startup deadline. Tracked in
   * `docs/todo/deferred-backlog.md`.
   */
  recordFailure(): HistoryWorkerRestartDecision {
    this.failures++
    const delayMs = this.delayFor(this.failures)
    const nextRetryAt = this.now() + delayMs
    this.pendingRetryAt = nextRetryAt
    return { consecutiveFailures: this.failures, delayMs, nextRetryAt }
  }

  /** A Worker reached `ready`: the streak is broken and no retry is outstanding. */
  recordSuccess(): void {
    this.failures = 0
    this.pendingRetryAt = undefined
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  get nextRetryAt(): number | undefined {
    return this.pendingRetryAt
  }

  /** Capped exponential: the first retry waits `initialDelayMs`, each later one doubles. */
  private delayFor(failures: number): number {
    if (this.initialDelayMs === 0 || this.maxDelayMs === 0) return 0
    return Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.max(0, failures - 1))
  }
}
