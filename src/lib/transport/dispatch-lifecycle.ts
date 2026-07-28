import type { AbortProvenanceGapSurface } from "~/lib/observability/abort-provenance-gaps"
import type {
  //
  DispatchDisposalResult,
  UpstreamDispatchLifecycle,
} from "~/lib/pipeline/types"

import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { recordAbortProvenanceGap } from "~/lib/observability/abort-provenance-gaps"
import { classifyStreamError } from "~/lib/stream"

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

/**
 * Own one HTTP-style physical dispatch without owning the pooled connection.
 * Cancellation reaches the fetch/body stream; disposal closes only the body iterator.
 */
export function createDispatchLifecycle(externalSignal?: AbortSignal, surface: AbortProvenanceGapSurface = "unknown"): DispatchLifecycleOwner {
  const controller = new AbortController()
  let activeIterator: AsyncIterator<unknown> | undefined
  let settled = false
  let cleanupPromise: Promise<void> | undefined
  let disposalPromise: Promise<DispatchDisposalResult> | undefined
  let resolveQuiesced!: () => void
  const quiesced = new Promise<void>((resolve) => {
    resolveQuiesced = resolve
  })
  let onExternalAbort = (): void => {}

  const complete = (): void => {
    if (settled) return
    settled = true
    externalSignal?.removeEventListener("abort", onExternalAbort)
    resolveQuiesced()
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
        } catch {
          // The lifecycle error already owns the terminal result. Cleanup is best-effort,
          // but quiescence is later than the cleanup attempt.
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
                // The SINGLE funnel for post-header stream failures: every guarded stream from both
                // transports passes through here exactly once. An `unknown-cancel` reaching this point
                // means some cancellation source aborted without calling `cancellationAbortError` —
                // a wiring gap, not a normal outcome — so count it here rather than at the ~18 route
                // sites that shape the frame (miss one of those and the counter under-reports, which
                // is worse than not having it: a zero would then read as "no gaps").
                if (classifyStreamError(error) === "unknown-cancel") recordAbortProvenanceGap("post-header", surface)
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
