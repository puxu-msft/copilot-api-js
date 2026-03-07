/**
 * Generic stream utilities for SSE-based streaming proxying.
 *
 * These utilities are protocol-agnostic — they work with any async iterator
 * and are used by Anthropic, OpenAI Chat Completions, and Responses handlers.
 */

// ============================================================================
// Stream idle timeout
// ============================================================================

/** Error thrown when no SSE event arrives within the configured idle timeout window */
export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream idle timeout: no event received within ${timeoutMs / 1000}s`)
    this.name = "StreamIdleTimeoutError"
  }
}

// ============================================================================
// Abort signal utilities
// ============================================================================

/** Sentinel value returned when shutdown abort signal fires during iterator.next() */
export const STREAM_ABORTED = Symbol("STREAM_ABORTED")

/**
 * Combine multiple abort signals into one.
 * Returns undefined if no valid signals provided. Returns the single signal
 * if only one is valid. Otherwise uses AbortSignal.any() to merge.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s !== undefined)
  if (valid.length === 0) return undefined
  if (valid.length === 1) return valid[0]
  return AbortSignal.any(valid)
}

// ============================================================================
// Iterator racing
// ============================================================================

/**
 * Race `iterator.next()` against idle timeout and/or shutdown abort signal.
 *
 * Without this, `await iterator.next()` blocks indefinitely when the upstream
 * connection is alive but sends no data — the shutdown signal check at the top
 * of the loop never gets reached. This function ensures the abort signal can
 * interrupt the wait.
 *
 * Returns `STREAM_ABORTED` when the abort signal fires (caller should break).
 * Rejects with `StreamIdleTimeoutError` if idle timeout fires first.
 */
export function raceIteratorNext<T>(
  promise: Promise<IteratorResult<T>>,
  opts: { idleTimeoutMs: number; abortSignal?: AbortSignal },
): Promise<IteratorResult<T> | typeof STREAM_ABORTED> {
  const { idleTimeoutMs, abortSignal } = opts

  // Fast path: already aborted
  if (abortSignal?.aborted) return Promise.resolve(STREAM_ABORTED)

  // Build the set of racing promises
  const racers: Array<Promise<IteratorResult<T> | typeof STREAM_ABORTED>> = [promise]
  const cleanups: Array<() => void> = []

  // Idle timeout racer
  if (idleTimeoutMs > 0) {
    let timeoutId: ReturnType<typeof setTimeout>
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new StreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs)
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    cleanups.push(() => clearTimeout(timeoutId!))
  }

  // Abort signal racer — resolves (not rejects) with sentinel so the caller
  // can distinguish shutdown from errors and complete gracefully
  if (abortSignal && !abortSignal.aborted) {
    let onAbort: () => void
    racers.push(
      new Promise<typeof STREAM_ABORTED>((resolve) => {
        onAbort = () => resolve(STREAM_ABORTED)
        abortSignal.addEventListener("abort", onAbort, { once: true })
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    cleanups.push(() => abortSignal.removeEventListener("abort", onAbort!))
  }

  return Promise.race(racers).finally(() => {
    for (const cleanup of cleanups) cleanup()
  })
}
