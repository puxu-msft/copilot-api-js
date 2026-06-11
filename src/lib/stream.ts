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

/**
 * Error thrown when an in-flight stream is interrupted by server shutdown
 * (the Phase 3 abort signal). Distinct from a client disconnect: the downstream
 * client is still connected and waiting, so handlers MUST surface this as a
 * terminal `error` event rather than closing the stream silently.
 *
 * Each handler's `catch` maps this to its protocol's transient/retryable error
 * shape so the client backs off and retries against the restarted instance:
 * Anthropic → `overloaded_error`, Gemini → `UNAVAILABLE`/503, OpenAI (Chat
 * Completions / Responses) → `server_error` (a 5xx-class transient type).
 */
export class StreamShutdownError extends Error {
  constructor() {
    super("Server is shutting down")
    this.name = "StreamShutdownError"
  }
}

/**
 * Error thrown when an in-flight stream is interrupted by the DOWNSTREAM CLIENT
 * disconnecting (client abort signal). Distinct from shutdown: there is no
 * client left to receive a terminal `error` frame, so handlers MUST settle the
 * request as `aborted` and must NOT attempt to write to the (closed) stream.
 * This separates a client-gone truncation from a genuine upstream failure so
 * history records it honestly rather than as a successful completion.
 */
export class StreamClientAbortError extends Error {
  constructor() {
    super("Client disconnected")
    this.name = "StreamClientAbortError"
  }
}

/** Coarse classification of a stream lifecycle error, protocol-agnostic. */
export type StreamErrorKind = "idle-timeout" | "shutdown" | "client-abort" | "other"

/**
 * Classify a streaming error into a protocol-agnostic kind. Every SSE handler
 * branches on this kind to pick its own protocol's error shape — Anthropic
 * (`overloaded_error`), Gemini (`UNAVAILABLE`), and the OpenAI surfaces (via
 * `streamErrorToOpenAIErrorType`) — so the `instanceof` checks live here in one
 * place instead of being repeated in each handler.
 */
export function classifyStreamError(error: unknown): StreamErrorKind {
  if (error instanceof StreamIdleTimeoutError) return "idle-timeout"
  if (error instanceof StreamShutdownError) return "shutdown"
  if (error instanceof StreamClientAbortError) return "client-abort"
  return "other"
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
 * idle-timeout and abort signals.
 *
 * `shutdownSignal` is the process-global, long-lived shutdown signal (stable
 * from process start, aborted at Phase 3). `clientSignal` is the per-request
 * downstream-disconnect signal. Both are forwarded into a single per-stream
 * local `AbortController` via explicit `addEventListener`/`removeEventListener`
 * (NOT `AbortSignal.any`): this keeps exactly one listener on the long-lived
 * shutdown signal per stream and removes it deterministically on every exit
 * path, rather than leaving cleanup to GC.
 *
 * Because the shutdown signal is stable (never undefined, never replaced
 * mid-stream), a `.next()` already blocked on a stalled upstream when shutdown
 * begins is still woken by the Phase 3 abort — no per-iteration recomputation
 * is needed.
 *
 * On idle timeout: rejects with `StreamIdleTimeoutError`.
 * On abort, the two signals have OPPOSITE semantics:
 * - **client abort** (downstream disconnected): yields `{ done: true }` cleanly —
 *   nobody is listening, so there is no one to notify.
 * - **shutdown abort** (server closing, client still connected): throws
 *   `StreamShutdownError` so the consumer's `catch` can emit a terminal error
 *   event instead of silently truncating the stream.
 * The abort source is resolved by querying the two ORIGINAL signals directly;
 * `client` is checked first (if the client is gone, a concurrent shutdown is
 * moot).
 *
 * Inner-iterator cleanup: `for await` only calls our `return()` when the
 * consumer `break`s or throws — NOT when our `next()` throws (idle-timeout /
 * shutdown) or returns the synthetic client-gone `{ done: true }`. On those
 * non-natural terminations the guard closes the underlying iterator itself
 * (idempotent) so the upstream connection is released. Natural completion needs
 * no close — the inner iterator has already ended. `return()` also forwards to
 * the underlying iterator for the early-break path.
 */
export function guardSseIterable<T>(
  source: AsyncIterable<T>,
  opts: {
    idleTimeoutMs: number
    shutdownSignal?: AbortSignal
    clientSignal?: AbortSignal
  },
): AsyncIterable<T> {
  const { idleTimeoutMs, shutdownSignal, clientSignal } = opts
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = source[Symbol.asyncIterator]()

      const local = new AbortController()
      const onAbort = () => local.abort()
      shutdownSignal?.addEventListener("abort", onAbort, { once: true })
      clientSignal?.addEventListener("abort", onAbort, { once: true })
      // Fast-path: a source was already aborted before the first next().
      if (shutdownSignal?.aborted || clientSignal?.aborted) local.abort()

      let detached = false
      const detach = () => {
        if (detached) return
        detached = true
        shutdownSignal?.removeEventListener("abort", onAbort)
        clientSignal?.removeEventListener("abort", onAbort)
      }

      // Close the underlying source. `for await` does NOT call our `return()`
      // when our `next()` throws (idle-timeout / shutdown) or returns a synthetic
      // `{ done: true }` (client gone) — in those cases the inner iterator is
      // still live and must be closed here, or its upstream connection leaks.
      //
      // CRITICAL: on those paths a stalled `inner.next()` is still pending, and
      // calling `return()` on a generator suspended mid-`await` queues behind that
      // next() — so `closeInner` is fire-and-forget on the next() paths (awaiting
      // would re-introduce the very hang the abort race exists to avoid). The
      // early-`break` path (consumer-driven `return()`) has no pending next(), so
      // there it is awaited to preserve return-value forwarding. Idempotent so the
      // two callers can't double-close.
      let innerClosed = false
      const closeInner = async (value?: T): Promise<IteratorResult<T> | undefined> => {
        if (innerClosed) return undefined
        innerClosed = true
        try {
          return await inner.return?.(value)
        } catch {
          // Source cleanup failed (already torn down) — nothing to recover.
          return undefined
        }
      }

      return {
        async next(): Promise<IteratorResult<T>> {
          let result: IteratorResult<T> | typeof STREAM_ABORTED
          try {
            result = await raceIteratorNext(inner.next(), { idleTimeoutMs, abortSignal: local.signal })
          } catch (error) {
            detach() // idle timeout (or other rejection) — the stream is over
            void closeInner() // fire-and-forget: inner.next() is still pending
            throw error
          }
          if (result === STREAM_ABORTED) {
            detach()
            void closeInner() // fire-and-forget: inner.next() is still pending
            // Check SHUTDOWN FIRST (process-level, retryable) so a concurrent
            // client disconnect can't mask it. Client gone → throw
            // StreamClientAbortError so the handler records the request as
            // `aborted` (distinct from completed) instead of settling a
            // truncated stream as success (Bug 2, uniform across endpoints).
            if (shutdownSignal?.aborted) throw new StreamShutdownError()
            if (clientSignal?.aborted) throw new StreamClientAbortError()
            return { value: undefined as unknown as T, done: true }
          }
          if (result.done) detach() // natural completion — inner already ended, no close needed
          return result
        },
        async return(value?: T): Promise<IteratorResult<T>> {
          detach()
          const closed = await closeInner(value)
          return closed ?? { value: value as T, done: true }
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
