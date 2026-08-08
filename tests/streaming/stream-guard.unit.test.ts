/**
 * `guardSseIterable` interruption + lifecycle.
 *
 * The shutdown signal is STABLE (created at process start, aborted once at
 * Phase 3 — see src/lib/shutdown.ts). guardSseIterable forwards it (and the
 * per-request client signal) into one local controller with explicit listener
 * cleanup. Because the signal is stable, a `.next()` that is ALREADY blocked on
 * a stalled upstream when the abort fires is still woken — the suite proves this
 * directly (the "case b" the previous design could not handle).
 */

import {
  //
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"

import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import {
  //
  StreamClientAbortError,
  StreamIdleTimeoutError,
  StreamReaperCancelError,
  StreamRequestCancelError,
  StreamRequestDeadlineError,
  StreamUnknownCancelError,
  classifyStreamError,
  guardSseIterable,
} from "~/lib/stream"

/** Async iterable that yields one frame, then blocks forever on the next */
function blockingAfterFirst(): AsyncIterable<{ data: string }> {
  let yielded = false
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<{ data: string }>> {
          if (!yielded) {
            yielded = true
            return { value: { data: "frame-1" }, done: false }
          }
          // Block forever — caller must rely on the abort signal to terminate.
          return new Promise<IteratorResult<{ data: string }>>(() => {
            // never resolves
          })
        },
        async return(): Promise<IteratorResult<{ data: string }>> {
          return { value: undefined, done: true }
        },
      }
    },
  }
}

/** Async iterable that yields a fixed sequence then ends normally */
function fixedSequence<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  let index = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (index >= items.length) return { value: undefined as unknown as T, done: true }
          const value = items[index]
          index += 1
          return { value, done: false }
        },
      }
    },
  }
}

/** Let the microtask/timer queue flush so a pending `.next()` is parked on the race. */
function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("guardSseIterable — stable-signal interruption (case b)", () => {
  test("client abort wakes an already-blocked .next() and throws StreamClientAbortError", async () => {
    const client = new AbortController()
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0,
      clientSignal: client.signal,
    })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    await tick()
    client.abort()

    await expect(secondPromise).rejects.toBeInstanceOf(StreamClientAbortError)
  })

  test("a client signal already aborted before the first .next() terminates immediately", async () => {
    const client = new AbortController()
    client.abort()
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0,
      clientSignal: client.signal,
    })
    const iter = guarded[Symbol.asyncIterator]()

    await expect(iter.next()).rejects.toBeInstanceOf(StreamClientAbortError)
  })
})

describe("guardSseIterable — abort-source distinction", () => {
  test("client abort → throws StreamClientAbortError", async () => {
    const client = new AbortController()
    const guarded = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 0, clientSignal: client.signal })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    client.abort()

    await expect(secondPromise).rejects.toBeInstanceOf(StreamClientAbortError)
  })


  test("reaper abort → throws StreamReaperCancelError (④, distinct from client-abort)", async () => {
    const reaper = new AbortController()
    const guarded = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 0, reaperSignal: reaper.signal })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    // Abort the way the real reaper does (`ctx.reapInFlight()`), i.e. WITH its cause tag.
    // A bare `reaper.abort()` here would be simulating the producer without its contract —
    // and would now (correctly) classify as an unknown cancel.
    reaper.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))

    await expect(secondPromise).rejects.toBeInstanceOf(StreamReaperCancelError)
  })

  test("client takes precedence over reaper when both aborted (no one to notify → silent abort wins)", async () => {
    const client = new AbortController()
    const reaper = new AbortController()
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0,
      clientSignal: client.signal,
      reaperSignal: reaper.signal,
    })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    client.abort()
    reaper.abort()

    await expect(secondPromise).rejects.toBeInstanceOf(StreamClientAbortError)
  })

  test("the hard deadline on the lifecycle signal is NOT reported as a reaper cancel", async () => {
    // `ctx.lifecycleSignal` carries the reaper, the hard deadline and any explicit
    // ctx.cancel(). Signal state alone cannot tell them apart, so this branch used to
    // answer "reaper" for all three — a request that blew its deadline reached the client
    // as a stale-request reap on EVERY streaming surface. The cause tag on the reason
    // is what makes the distinction possible.
    const lifecycle = new AbortController()
    const guarded = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 0, reaperSignal: lifecycle.signal })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    lifecycle.abort(cancellationAbortError("request-deadline", "request_deadline"))

    const error = await secondPromise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StreamRequestDeadlineError)
    expect(error).not.toBeInstanceOf(StreamReaperCancelError)
    expect(classifyStreamError(error)).toBe("request-deadline")
  })

  test("an explicit ctx.cancel is its own kind; an UNTAGGED lifecycle abort is an honest unknown, NOT a fabricated reaper", async () => {
    const cancelled = new AbortController()
    const guardedCancel = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 0, reaperSignal: cancelled.signal })
    const cancelIter = guardedCancel[Symbol.asyncIterator]()
    await cancelIter.next()
    const cancelPending = cancelIter.next()
    cancelled.abort(cancellationAbortError("request-cancel", "operator cancelled"))
    await expect(cancelPending).rejects.toBeInstanceOf(StreamRequestCancelError)

    // Every in-repo producer tags its reason, so an untagged one no longer means "the reaper,
    // as always" — it means some producer skipped the contract. Answering "reaper" would put a
    // specific, unearned cause on the wire, which is the exact failure this taxonomy exists to
    // stop. The negative assertion is the load-bearing half: no reaper text may reach the client.
    const untagged = new AbortController()
    const guardedUntagged = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 0, reaperSignal: untagged.signal })
    const untaggedIter = guardedUntagged[Symbol.asyncIterator]()
    await untaggedIter.next()
    const untaggedPending = untaggedIter.next()
    untagged.abort()
    const untaggedError = await untaggedPending.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(untaggedError).toBeInstanceOf(StreamUnknownCancelError)
    expect(untaggedError).not.toBeInstanceOf(StreamReaperCancelError)
    expect((untaggedError as Error).message).not.toMatch(/reaper/i)
    expect(classifyStreamError(untaggedError)).toBe("unknown-cancel")
  })

  test("classifyStreamError maps reaper-cancel to its OWN kind, NOT client-abort (→ routes to stream-error, not settled-abort)", () => {
    // The driver's sink loop maps ONLY "client-abort" → settled-abort (silent);
    // everything else → stream-error (handler delivers an error frame). So a
    // reaper-cancel MUST classify as its own kind for the live client to get the frame.
    expect(classifyStreamError(new StreamReaperCancelError())).toBe("reaper-cancel")
    expect(classifyStreamError(new StreamReaperCancelError(900))).toBe("reaper-cancel")
    expect(classifyStreamError(new StreamClientAbortError())).toBe("client-abort")
  })
})

describe("guardSseIterable — lifecycle", () => {
  test("propagates natural completion as { done: true }", async () => {
    const guarded = guardSseIterable(fixedSequence([{ data: "a" }, { data: "b" }]), { idleTimeoutMs: 0 })

    const collected: Array<{ data: string }> = []
    for await (const ev of guarded) collected.push(ev)

    expect(collected).toEqual([{ data: "a" }, { data: "b" }])
  })

  test("idle timeout rejects with StreamIdleTimeoutError when no event arrives in window", async () => {
    const guarded = guardSseIterable(blockingAfterFirst(), { idleTimeoutMs: 50 })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next() // first yields immediately

    let caught: unknown
    try {
      await iter.next() // second blocks → idle timeout fires
    } catch (err: unknown) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StreamIdleTimeoutError)
  })

  test("return() forwards to underlying iterator for cleanup", async () => {
    let returned = false
    const source: AsyncIterable<{ data: string }> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<{ data: string }>> {
            return { value: { data: "x" }, done: false }
          },
          async return(): Promise<IteratorResult<{ data: string }>> {
            returned = true
            return { value: undefined, done: true }
          },
        }
      },
    }

    const guarded = guardSseIterable(source, { idleTimeoutMs: 0 })
    const iter = guarded[Symbol.asyncIterator]()
    await iter.next()
    if (iter.return) await iter.return()

    expect(returned).toBe(true)
  })
})

describe("guardSseIterable — no listener leak on request signals", () => {
  test("removes its abort listener on natural completion", async () => {
    const client = new AbortController()
    const removeSpy = spyOn(client.signal, "removeEventListener")
    const guarded = guardSseIterable(fixedSequence([{ data: "a" }]), {
      idleTimeoutMs: 0,
      clientSignal: client.signal,
    })

    for await (const _ of guarded) {
      // drain to natural completion
    }

    expect(removeSpy).toHaveBeenCalled()
  })

  test("removes its abort listener on early return()", async () => {
    const client = new AbortController()
    const removeSpy = spyOn(client.signal, "removeEventListener")
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0,
      clientSignal: client.signal,
    })
    const iter = guarded[Symbol.asyncIterator]()
    await iter.next()
    if (iter.return) await iter.return()

    expect(removeSpy).toHaveBeenCalled()
  })

  test("removes its abort listener after idle timeout", async () => {
    const client = new AbortController()
    const removeSpy = spyOn(client.signal, "removeEventListener")
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 30,
      clientSignal: client.signal,
    })
    const iter = guarded[Symbol.asyncIterator]()
    await iter.next()
    await iter.next().catch(() => {
      // idle timeout
    })

    expect(removeSpy).toHaveBeenCalled()
  })
})

/**
 * `for await` does NOT call our `return()` when our `next()` throws
 * (idle-timeout / shutdown) or returns a synthetic `{ done: true }` (client gone).
 * In those non-natural terminations the inner iterator is still live, so the
 * guard must close it explicitly or the upstream connection leaks. Natural
 * completion needs no close — the inner iterator already ended.
 */
describe("guardSseIterable — closes the inner iterator on non-natural termination", () => {
  /** Yields one frame then blocks forever; counts how many times return() is called. */
  function instrumentedBlocking(): { source: AsyncIterable<{ data: string }>; returnCalls: () => number } {
    let returnCalls = 0
    let yielded = false
    const source: AsyncIterable<{ data: string }> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<{ data: string }>> {
            if (!yielded) {
              yielded = true
              return { value: { data: "frame-1" }, done: false }
            }
            return new Promise<IteratorResult<{ data: string }>>(() => {
              // never resolves
            })
          },
          async return(): Promise<IteratorResult<{ data: string }>> {
            returnCalls += 1
            return { value: undefined, done: true }
          },
        }
      },
    }
    return { source, returnCalls: () => returnCalls }
  }

  /** Yields a finite sequence then ends naturally; counts return() calls. */
  function instrumentedFinite(items: ReadonlyArray<{ data: string }>): {
    source: AsyncIterable<{ data: string }>
    returnCalls: () => number
  } {
    let returnCalls = 0
    let index = 0
    const source: AsyncIterable<{ data: string }> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<{ data: string }>> {
            if (index >= items.length) return { value: undefined as unknown as { data: string }, done: true }
            const value = items[index]
            index += 1
            return { value, done: false }
          },
          async return(): Promise<IteratorResult<{ data: string }>> {
            returnCalls += 1
            return { value: undefined, done: true }
          },
        }
      },
    }
    return { source, returnCalls: () => returnCalls }
  }

  test("client abort closes the inner iterator (cleanup runs before the throw)", async () => {
    const client = new AbortController()
    const { source, returnCalls } = instrumentedBlocking()
    const guarded = guardSseIterable(source, { idleTimeoutMs: 0, clientSignal: client.signal })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    await tick()
    client.abort()

    await expect(secondPromise).rejects.toBeInstanceOf(StreamClientAbortError)
    expect(returnCalls()).toBe(1)
  })

  test("idle timeout closes the inner iterator", async () => {
    const { source, returnCalls } = instrumentedBlocking()
    const guarded = guardSseIterable(source, { idleTimeoutMs: 30 })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    await iter.next().catch(() => {
      // idle timeout
    })

    expect(returnCalls()).toBe(1)
  })

  test("natural completion does NOT close the inner iterator", async () => {
    const { source, returnCalls } = instrumentedFinite([{ data: "a" }, { data: "b" }])
    const guarded = guardSseIterable(source, { idleTimeoutMs: 0 })

    for await (const _ of guarded) {
      // drain to natural completion
    }

    expect(returnCalls()).toBe(0)
  })

  test("a non-resolving inner.return() does NOT block termination (fire-and-forget)", async () => {
    // The whole reason `next()` closes the inner iterator fire-and-forget: a real
    // async generator stalled mid-`await` queues its `return()` behind the pending
    // `next()`, so `return()` never settles. Awaiting it would re-introduce the
    // hang the abort race exists to avoid. Here `return()` never resolves; the
    // guard must still surface the request cancellation promptly instead of hanging on it.
    let yielded = false
    const source: AsyncIterable<{ data: string }> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<{ data: string }>> {
            if (!yielded) {
              yielded = true
              return { value: { data: "frame-1" }, done: false }
            }
            return new Promise<IteratorResult<{ data: string }>>(() => {
              // never resolves
            })
          },
          return(): Promise<IteratorResult<{ data: string }>> {
            return new Promise<IteratorResult<{ data: string }>>(() => {
              // never resolves — mimics return() queued behind a stalled next()
            })
          },
        }
      },
    }

    const client = new AbortController()
    const guarded = guardSseIterable(source, { idleTimeoutMs: 0, clientSignal: client.signal })
    const iter = guarded[Symbol.asyncIterator]()

    await iter.next()
    const secondPromise = iter.next()
    await tick()
    client.abort()

    // The terminating next() must settle (throw) rather than hang on return().
    const outcome = await Promise.race([
      secondPromise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 200)),
    ])
    expect(outcome).toBe("settled")
    await expect(secondPromise).rejects.toBeInstanceOf(StreamClientAbortError)
  })
})
