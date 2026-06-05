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
 *
 * Lifecycle note: `AbortSignal.any` on modern Node/Bun uses WeakRef for its
 * source-signal references, so the composite signal does not pin its sources
 * once it becomes unreachable — short-lived per-request use is safe without
 * an explicit dispose handle. For long-lived consumers (e.g. a stream
 * generator that lives across many ticks), prefer a dedicated AbortController
 * forwarded from the long-lived signals so cleanup is explicit.
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

// ============================================================================
// SSE iterator helpers
// ============================================================================

/** Shape of an SSE frame as produced by `fetch-event-stream` and our pipeline. */
export interface SseFrame {
  event?: string
  data?: string
}

/**
 * Obtain an `AsyncIterator<SseFrame>` from whatever the request pipeline
 * returns for a streaming response. The pipeline's union return type forces
 * a narrowing cast at every consumer; this helper concentrates the cast in
 * one place so consumers stay readable and the cast assumption (pipeline
 * returns AsyncIterable for streaming requests) is documented once.
 */
export function iterateSseEvents(response: unknown): AsyncIterator<SseFrame> {
  return (response as AsyncIterable<SseFrame>)[Symbol.asyncIterator]()
}

/**
 * Wrap an async-iterable SSE source so each `.next()` is raced against an
 * idle-timeout + abort signal recomputed PER ITERATION.
 *
 * `getAbortSignal` is a thunk recomputed per iteration. The shutdown signal
 * starts out `undefined` and only materializes when Phase 1 of graceful
 * shutdown begins; baking it in at construction time would leave already-in-
 * flight requests deaf to the abort signal. Each `.next()` therefore re-asks
 * for the live signal composition (typically
 * `combineAbortSignals(getShutdownSignal(), clientAbortSignal)`).
 *
 * On idle timeout: rejects with `StreamIdleTimeoutError`.
 * On abort: yields `{ done: true }` cleanly (no exception). The `STREAM_ABORTED`
 * sentinel from `raceIteratorNext` is translated here so callers can use a
 * plain `for await` loop without sentinel-comparison branches.
 *
 * `return()` is forwarded to the underlying iterator so resource cleanup
 * (e.g. closing the upstream connection on early break) still works.
 */
export function guardSseIterable<T>(
  source: AsyncIterable<T>,
  opts: { idleTimeoutMs: number; getAbortSignal?: () => AbortSignal | undefined },
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = source[Symbol.asyncIterator]()
      return {
        async next(): Promise<IteratorResult<T>> {
          const abortSignal = opts.getAbortSignal?.()
          const result = await raceIteratorNext(inner.next(), {
            idleTimeoutMs: opts.idleTimeoutMs,
            abortSignal,
          })
          if (result === STREAM_ABORTED) return { value: undefined as unknown as T, done: true }
          return result
        },
        async return(value?: T): Promise<IteratorResult<T>> {
          if (inner.return) return inner.return(value)
          return { value: value as T, done: true }
        },
      }
    },
  }
}

// ============================================================================
// Base stream accumulator interface
// ============================================================================

/**
 * Minimal accumulator contract for tracking and error recording.
 * Shared by Anthropic, OpenAI Chat Completions, and Responses accumulators.
 */
export interface BaseStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  /** Plain text content accumulated from text deltas (error recording fallback) */
  rawContent: string
}
