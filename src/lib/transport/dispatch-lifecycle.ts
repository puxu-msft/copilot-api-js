import type {
  //
  DispatchDisposalResult,
  UpstreamDispatchLifecycle,
} from "~/lib/pipeline/types"

import { cancellationAbortError } from "~/lib/error/cancellation-reason"

export interface DispatchLifecycleOwner extends UpstreamDispatchLifecycle {
  readonly signal: AbortSignal
  /** Mark a non-streaming or failed-open dispatch fully quiesced. */
  complete(): void
  /** Wrap the owned response body so natural EOF/throw/return settles quiescence. */
  ownFrames<T>(source: AsyncIterable<T>): AsyncIterable<T>
  /**
   * Register the transport's PHYSICAL teardown wait, so `dispose()` reports quiescence only once the underlying stream is actually gone.
   *
   * Without this, `dispose()` resolves as soon as the body iterator is closed — which is a claim about OUR bookkeeping, not about the wire. The pooled connection may still be carrying a half-dead stream, and the contract `dispose()` advertises ("no local callbacks remain") is not yet true.
   *
   * Bounded by `graceMs`: a peer that never closes must not wedge teardown. On expiry the dispatch is reported NOT reusable, because the honest answer is that we no longer know the connection's state.
   */
  registerTeardownBarrier(barrier: TeardownBarrier): void
}

export interface TeardownBarrier {
  /** Resolves when the transport's physical stream has closed. */
  closed: Promise<void>
  /** Upper bound on the wait; `<= 0` disables the barrier entirely. */
  graceMs: number
  /** Invoked exactly once if the grace expires before `closed` — the seam A4-4's forced disposal hangs off. */
  onTimeout?: () => void
}

/**
 * Candidate/dispatch-local teardown reason. Tagged `dispatch-cancel` so the client
 * boundaries can tell an internal disposal (hedge loser, forced cleanup) apart from
 * a reaper cancel, a hard deadline or an upstream header timeout — they all used to
 * arrive as the same untyped `AbortError`.
 */
function abortReason(reason?: string): DOMException {
  return cancellationAbortError("dispatch-cancel", reason ?? "The operation was aborted.")
}

/**
 * Own one HTTP-style physical dispatch without owning the pooled connection.
 * Cancellation reaches the fetch/body stream; disposal closes only the body iterator.
 */
export function createDispatchLifecycle(externalSignal?: AbortSignal): DispatchLifecycleOwner {
  const controller = new AbortController()
  let activeIterator: AsyncIterator<unknown> | undefined
  let settled = false
  let cleanupPromise: Promise<void> | undefined
  let disposalPromise: Promise<DispatchDisposalResult> | undefined
  let resolveQuiesced!: () => void
  let rejectQuiesced!: (error: unknown) => void
  const quiesced = new Promise<void>((resolve, reject) => {
    resolveQuiesced = resolve
    rejectQuiesced = reject
  })
  // Observe internally so external-abort cleanup cannot create an unhandled rejection when no caller joins quiesced.
  void quiesced.catch(() => {})
  let onExternalAbort = (): void => {}
  let teardownBarrier: TeardownBarrier | undefined

  const complete = (error?: unknown, failed = false): void => {
    if (settled) return
    settled = true
    externalSignal?.removeEventListener("abort", onExternalAbort)
    if (failed) rejectQuiesced(error)
    else resolveQuiesced()
  }

  const cancel = (reason?: string): void => {
    if (!controller.signal.aborted) controller.abort(abortReason(reason))
  }

  const ensureIteratorCleanup = (): Promise<void> => {
    if (settled) return (cleanupPromise ??= Promise.resolve())
    cleanupPromise ??= (async () => {
      const iterator = activeIterator
      if (iterator?.return) {
        try {
          await iterator.return()
        } catch (error) {
          complete(error, true)
          throw error
        }
      }
      complete()
    })()
    return cleanupPromise
  }

  function dispose(reason?: string): Promise<DispatchDisposalResult> {
    disposalPromise ??= (async () => {
      cancel(reason)
      await ensureIteratorCleanup()
      await quiesced
      // Only now is OUR bookkeeping done. The physical stream may still be closing, and until it is,
      // "no local callbacks remain" is not yet true — so the barrier, not `quiesced`, decides reusability.
      const closedInTime = await awaitTeardownBarrier()
      // Reusability is a REPORT to the caller, never an action on the pool: an expired grace means we
      // no longer know this connection's state, and guessing "fine" would put the next request on it.
      if (!closedInTime) return { quiesced: true, connectionReusable: false }
      return { quiesced: true, connectionReusable: true }
    })()
    return disposalPromise
  }

  /** Resolves true if the transport closed within its grace, false if the grace expired (or `true` when no barrier was registered — nothing to wait for). */
  async function awaitTeardownBarrier(): Promise<boolean> {
    const barrier = teardownBarrier
    if (barrier === undefined || barrier.graceMs <= 0) return true

    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), barrier.graceMs)
      // Teardown must never be the reason the process stays alive at shutdown.
      timer.unref()
    })
    try {
      const closedInTime = await Promise.race([barrier.closed.then(() => true), expired])
      if (!closedInTime) barrier.onTimeout?.()
      return closedInTime
    } catch {
      // A rejected barrier is still a finished wait; the connection's state is unknown, so: not reusable.
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  onExternalAbort = () => {
    const reason = externalSignal?.reason instanceof Error ? externalSignal.reason.message : undefined
    // Candidate/request cancellation owns teardown, not just the caller's wait. Observe the
    // promise because AbortSignal listeners cannot await; `quiesced` remains the public barrier.
    void dispose(reason).catch(() => {})
  }
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
  if (externalSignal?.aborted) onExternalAbort()

  return {
    signal: controller.signal,
    cancel,
    dispose,
    quiesced,
    complete,
    registerTeardownBarrier(barrier: TeardownBarrier): void {
      // Registered once, by the transport that owns the physical stream. A second registration would
      // mean two owners disagree about what "closed" means, so the first one wins rather than racing.
      teardownBarrier ??= barrier
    },
    ownFrames<T>(source: AsyncIterable<T>): AsyncIterable<T> {
      if (settled || controller.signal.aborted) {
        return {
          [Symbol.asyncIterator](): AsyncIterator<T> {
            return {
              async next(): Promise<IteratorResult<T>> {
                throw controller.signal.reason ?? abortReason()
              },
              async return(value?: T): Promise<IteratorResult<T>> {
                return { done: true, value: value as T }
              },
            }
          },
        }
      }
      // Claim the response body NOW, before transport.send returns it. This makes an
      // unconsumed body a real owned resource that dispose() can close and await.
      const inner = source[Symbol.asyncIterator]()
      activeIterator = inner as AsyncIterator<unknown>
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          // Cancellation may race between ownFrames() and the consumer claiming this wrapper.
          if (settled || controller.signal.aborted) {
            return {
              async next(): Promise<IteratorResult<T>> {
                throw controller.signal.reason ?? abortReason()
              },
              async return(value?: T): Promise<IteratorResult<T>> {
                return { done: true, value: value as T }
              },
            }
          }
          return {
            async next(): Promise<IteratorResult<T>> {
              try {
                const result = await inner.next()
                if (result.done) complete()
                return result
              } catch (error) {
                // Surface the lifecycle error immediately, but do not claim quiescence until the
                // guard/source iterator's single cleanup promise has completed.
                void ensureIteratorCleanup().catch(() => {})
                throw error
              }
            },
            async return(value?: T): Promise<IteratorResult<T>> {
              await ensureIteratorCleanup()
              return { done: true, value: value as T }
            },
            async throw(error?: unknown): Promise<IteratorResult<T>> {
              await ensureIteratorCleanup()
              throw error
            },
          }
        },
      }
    },
  }
}
