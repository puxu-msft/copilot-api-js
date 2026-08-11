import type {
  //
  DispatchDisposalResult,
  UpstreamDispatchLifecycle,
} from "~/lib/pipeline/types"

import {
  //
  cancellationAbortError,
  UPSTREAM_REQUEST_DEADLINE_CANCEL_REASON,
} from "~/lib/error/cancellation-reason"

export interface DispatchLifecycleOwner extends UpstreamDispatchLifecycle {
  readonly signal: AbortSignal
  /** Mark a non-streaming or failed-open dispatch fully quiesced. */
  complete(): void
  /** Wrap the owned response body so natural EOF/throw/return settles quiescence. */
  ownFrames<T>(source: AsyncIterable<T>): AsyncIterable<T>
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

export interface DispatchLifecycleOptions {
  /**
   * Wall-clock cap for this ONE upstream attempt (`timeouts.upstream_request_deadline`, ms).
   * 0/undefined = disabled and nothing is armed. On fire the dispatch is aborted with an
   * `upstream-request-deadline` cause and torn down like any other disposal — the owning
   * candidate's retry/hedge budget is untouched, so this bounds the attempt, not the request.
   */
  readonly deadlineMs?: number
}

/**
 * Own one HTTP-style physical dispatch without owning the pooled connection.
 * Cancellation reaches the fetch/body stream; disposal closes only the body iterator.
 */
export function createDispatchLifecycle(externalSignal?: AbortSignal, options?: DispatchLifecycleOptions): DispatchLifecycleOwner {
  const controller = new AbortController()
  let activeIterator: AsyncIterator<unknown> | undefined
  let settled = false
  let cleanupPromise: Promise<void> | undefined
  let disposalPromise: Promise<DispatchDisposalResult> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let resolveQuiesced!: () => void
  let rejectQuiesced!: (error: unknown) => void
  const quiesced = new Promise<void>((resolve, reject) => {
    resolveQuiesced = resolve
    rejectQuiesced = reject
  })
  // Observe internally so external-abort cleanup cannot create an unhandled rejection when no caller joins quiesced.
  void quiesced.catch(() => {})
  let onExternalAbort = (): void => {}

  const clearDeadline = (): void => {
    if (deadlineTimer === undefined) return
    clearTimeout(deadlineTimer)
    deadlineTimer = undefined
  }

  const complete = (error?: unknown, failed = false): void => {
    if (settled) return
    settled = true
    clearDeadline()
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
      return { quiesced: true, connectionReusable: true }
    })()
    return disposalPromise
  }

  onExternalAbort = () => {
    const reason = externalSignal?.reason instanceof Error ? externalSignal.reason.message : undefined
    // Candidate/request cancellation owns teardown, not just the caller's wait. Observe the
    // promise because AbortSignal listeners cannot await; `quiesced` remains the public barrier.
    void dispose(reason).catch(() => {})
  }
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
  if (externalSignal?.aborted) onExternalAbort()

  // Per-attempt hard deadline. Abort FIRST with our own tagged error so the cause survives:
  // `dispose` → `cancel` only aborts when the signal is still unaborted, so it will not overwrite
  // this tag with the generic `dispatch-cancel` one. `unref` keeps it from holding the process up.
  const deadlineMs = options?.deadlineMs ?? 0
  if (deadlineMs > 0) {
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined
      if (settled || controller.signal.aborted) return
      controller.abort(
        cancellationAbortError("upstream-request-deadline", `Upstream attempt exceeded ${deadlineMs / 1000}s (${UPSTREAM_REQUEST_DEADLINE_CANCEL_REASON})`),
      )
      void dispose(UPSTREAM_REQUEST_DEADLINE_CANCEL_REASON).catch(() => {})
    }, deadlineMs)
    ;(deadlineTimer as unknown as { unref?: () => void }).unref?.()
  }

  return {
    signal: controller.signal,
    cancel,
    dispose,
    quiesced,
    complete,
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
