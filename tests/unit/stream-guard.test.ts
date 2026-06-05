/**
 * `guardSseIterable` must recompute the abort signal on every iteration.
 * Capturing the signal once at construction time would leave already-in-flight
 * requests deaf to a shutdown signal that materializes later, because
 * `getShutdownSignal()` returns `undefined` until Phase 1 begins.
 *
 * This unit suite exercises the public helper directly (extracted from the
 * gemini handler and shared across all three SSE-forwarding handlers).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  StreamIdleTimeoutError,
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

describe("guardSseIterable abort signal thunk", () => {
  test("recomputes abort signal per iteration — late-arriving signal still terminates the stream", async () => {
    // ref.controller materializes AFTER the iterator has been constructed,
    // mimicking `getShutdownSignal()` returning undefined until Phase 1
    // begins. If guardSseIterable captured the signal once at construction
    // time, the second `.next()` below would hang forever (signal was
    // undefined at that moment).
    const ref: { controller: AbortController | undefined } = { controller: undefined }
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0, // disable idle timeout — we want to prove the signal does the work
      getAbortSignal: () => ref.controller?.signal,
    })

    const iter = guarded[Symbol.asyncIterator]()

    // Pull the first frame — succeeds before the signal exists.
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ data: "frame-1" })

    // Install the controller BEFORE the second pull starts, but do not abort
    // until after the pull is in flight. This proves the thunk is read at
    // the start of each `.next()` (not at construction) — exactly the path
    // a mid-stream shutdown takes.
    ref.controller = new AbortController()
    const secondPromise = iter.next()
    ref.controller.abort()

    const second = await secondPromise
    expect(second.done).toBe(true)
  })

  test("captures shutdown signal that becomes available between iterations", async () => {
    const ref: { controller: AbortController | undefined } = { controller: undefined }
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 0,
      getAbortSignal: () => ref.controller?.signal,
    })

    const iter = guarded[Symbol.asyncIterator]()

    // First pull: no signal yet — succeeds.
    await iter.next()

    // Between iterations, install + fire the signal. The thunk MUST observe
    // this on the next iteration even though no signal existed during the
    // previous one — captures the per-iteration recomputation path.
    ref.controller = new AbortController()
    ref.controller.abort()

    // Second pull: thunk observes the now-present aborted signal and bails
    // immediately via the fast-path inside raceIteratorNext.
    const second = await iter.next()
    expect(second.done).toBe(true)
  })
})

describe("guardSseIterable lifecycle", () => {
  test("propagates natural completion as { done: true }", async () => {
    const guarded = guardSseIterable(fixedSequence([{ data: "a" }, { data: "b" }]), {
      idleTimeoutMs: 0,
    })

    const collected: Array<{ data: string }> = []
    for await (const ev of guarded) collected.push(ev)

    expect(collected).toEqual([{ data: "a" }, { data: "b" }])
  })

  test("idle timeout rejects with StreamIdleTimeoutError when no event arrives in window", async () => {
    const guarded = guardSseIterable(blockingAfterFirst(), {
      idleTimeoutMs: 50,
    })
    const iter = guarded[Symbol.asyncIterator]()

    // First yields immediately
    await iter.next()

    // Second blocks → idle timeout fires
    let caught: unknown
    try {
      await iter.next()
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
