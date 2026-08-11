import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { getCancellationCause } from "~/lib/error/cancellation-reason"
import { guardSseIterable } from "~/lib/stream"
import { createDispatchLifecycle } from "~/lib/transport/dispatch-lifecycle"

function pendingSource(): {
  source: AsyncIterable<string>
  active: () => boolean
  returns: () => number
} {
  let active = false
  let returns = 0
  let finish: ((result: IteratorResult<string>) => void) | undefined
  return {
    source: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            active = true
            return new Promise((resolve) => {
              finish = resolve
            })
          },
          async return(): Promise<IteratorResult<string>> {
            returns++
            active = false
            finish?.({ done: true, value: undefined })
            return { done: true, value: undefined }
          },
        }
      },
    },
    active: () => active,
    returns: () => returns,
  }
}

describe("physical dispatch lifecycle", () => {
  test("natural body completion resolves quiesced and keeps the pooled connection reusable", async () => {
    const lifecycle = createDispatchLifecycle()
    const frames = lifecycle.ownFrames(
      (async function* () {
        yield "frame"
      })(),
    )

    expect(await Array.fromAsync(frames)).toEqual(["frame"])
    await expect(lifecycle.quiesced).resolves.toBeUndefined()
    await expect(lifecycle.dispose()).resolves.toEqual({ quiesced: true, connectionReusable: true })
  })

  test("iterator return rejection rejects quiesced and dispose with the original error", async () => {
    const cleanupError = new Error("iterator return failed")
    const lifecycle = createDispatchLifecycle()
    const frames = lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            throw cleanupError
          },
        }
      },
    })
    frames[Symbol.asyncIterator]()

    const quiescedResult = lifecycle.quiesced.then(
      () => undefined,
      (error: unknown) => error,
    )
    const first = lifecycle.dispose("test cleanup")
    const second = lifecycle.dispose("repeat cleanup")
    expect(first).toBe(second)
    await expect(first).rejects.toBe(cleanupError)
    await expect(quiescedResult).resolves.toBe(cleanupError)
  })

  test.each([undefined, null, "cleanup string", Number.NaN])("preserves unknown cleanup rejection %#", async (cleanupError) => {
    const lifecycle = createDispatchLifecycle()
    let returnCalls = 0
    lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            returnCalls++
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error: this test drives the unknown-rejection path, where a thrown/rejected `undefined`/`NaN` is legal and must not be detectable by a value sentinel
            throw cleanupError
          },
        }
      },
    })
    const quiesced = lifecycle.quiesced.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    const disposal = lifecycle.dispose("unknown cleanup")
    const disposalOutcome = await disposal.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(disposalOutcome).toEqual({ state: "rejected", error: cleanupError })
    expect(await quiesced).toEqual({ state: "rejected", error: cleanupError })
    expect(returnCalls).toBe(1)
  })

  test("deduplicates repeated primitive cleanup failures", async () => {
    const lifecycle = createDispatchLifecycle()
    lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error: this test drives the unknown-rejection path, where a thrown/rejected `undefined`/`NaN` is legal and must not be detectable by a value sentinel
            throw Number.NaN
          },
        }
      },
    })
    const disposal = lifecycle.dispose("same primitive")
    const outcome = await disposal.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(outcome).toEqual({ state: "rejected", error: Number.NaN })
  })

  test("external abort catches internal disposal while public quiesced preserves the cleanup error", async () => {
    const cleanupError = new Error("external iterator return failed")
    const external = new AbortController()
    const lifecycle = createDispatchLifecycle(external.signal)
    lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            throw cleanupError
          },
        }
      },
    })
    let unhandled: unknown
    const onUnhandled = (reason: unknown) => {
      unhandled = reason
    }
    process.once("unhandledRejection", onUnhandled)

    external.abort(new Error("candidate lost"))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(unhandled).toBeUndefined()
    await expect(lifecycle.quiesced).rejects.toBe(cleanupError)
    process.removeListener("unhandledRejection", onUnhandled)
  })

  test("dispose aborts and returns the owned pending body iterator before its barrier resolves", async () => {
    const fixture = pendingSource()
    const lifecycle = createDispatchLifecycle()
    const iterator = lifecycle.ownFrames(fixture.source)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    expect(fixture.active()).toBe(true)

    const result = await lifecycle.dispose("hedged loser")

    expect(result).toEqual({ quiesced: true, connectionReusable: true })
    expect(lifecycle.signal.aborted).toBe(true)
    expect(fixture.returns()).toBe(1)
    expect(fixture.active()).toBe(false)
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  test("cooperative cancel aborts the signal but waits for the owned pending body to unwind", async () => {
    const fixture = pendingSource()
    const lifecycle = createDispatchLifecycle()
    const iterator = lifecycle.ownFrames(fixture.source)[Symbol.asyncIterator]()
    void iterator.next()
    await Promise.resolve()
    let quiesced = false
    void lifecycle.quiesced.then(() => {
      quiesced = true
    })

    lifecycle.cancel("candidate lost")
    await Promise.resolve()

    expect(lifecycle.signal.aborted).toBe(true)
    expect(quiesced).toBe(false)
    await lifecycle.dispose("force cleanup")
    expect(quiesced).toBe(true)
  })

  test("external candidate cancellation propagates into the dispatch signal", async () => {
    const candidate = new AbortController()
    const lifecycle = createDispatchLifecycle(candidate.signal)
    let sourceOpened = 0
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        sourceOpened++
        return {
          async next() {
            return { done: false, value: "late-frame" }
          },
        }
      },
    }

    candidate.abort(new Error("candidate lost"))

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.signal.reason).toBeInstanceOf(Error)
    await expect(lifecycle.quiesced).resolves.toBeUndefined()
    const iterator = lifecycle.ownFrames(source)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow("candidate lost")
    expect(sourceOpened).toBe(0)
  })

  test("an unconsumed owned body does not quiesce until its delayed return barrier completes", async () => {
    const candidate = new AbortController()
    let returnStarted = false
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            return new Promise(() => {})
          },
          async return(): Promise<IteratorResult<string>> {
            returnStarted = true
            await returnGate
            return { done: true, value: undefined }
          },
        }
      },
    }
    const lifecycle = createDispatchLifecycle(candidate.signal)
    // Transport owns the body before returning it, even though the caller never consumes it.
    lifecycle.ownFrames(source)
    let quiesced = false
    void lifecycle.quiesced.then(() => {
      quiesced = true
    })

    candidate.abort(new Error("candidate lost"))
    await Promise.resolve()

    expect(returnStarted).toBe(true)
    expect(quiesced).toBe(false)
    releaseReturn()
    await lifecycle.quiesced
    expect(quiesced).toBe(true)
  })

  test("guard cancellation waits for the same delayed source-return promise before quiescing", async () => {
    const candidate = new AbortController()
    let returnStarted = false
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return new Promise(() => {})
          },
          async return(): Promise<IteratorResult<string>> {
            returnStarted = true
            await returnGate
            return { done: true, value: undefined }
          },
        }
      },
    }
    const lifecycle = createDispatchLifecycle(candidate.signal)
    const guarded = guardSseIterable(source, { idleTimeoutMs: 0, dispatchSignal: lifecycle.signal })
    const iterator = lifecycle.ownFrames(guarded)[Symbol.asyncIterator]()
    const pending = iterator.next()
    void pending.catch(() => {})
    await Promise.resolve()
    let quiesced = false
    void lifecycle.quiesced.then(() => {
      quiesced = true
    })

    candidate.abort(new Error("candidate lost"))
    await Promise.resolve()
    await Promise.resolve()

    expect(returnStarted).toBe(true)
    expect(quiesced).toBe(false)
    releaseReturn()
    await lifecycle.quiesced
    expect(quiesced).toBe(true)
    await expect(pending).rejects.toThrow("Upstream dispatch cancelled")
  })

  test("client-abort guard error surfaces before cleanup, while quiesced waits for delayed return", async () => {
    const clientAbort = new AbortController()
    let returnStarted = false
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return new Promise(() => {})
          },
          async return(): Promise<IteratorResult<string>> {
            returnStarted = true
            await returnGate
            return { done: true, value: undefined }
          },
        }
      },
    }
    const lifecycle = createDispatchLifecycle()
    const guarded = guardSseIterable(source, { idleTimeoutMs: 0, clientSignal: clientAbort.signal })
    const pending = lifecycle.ownFrames(guarded)[Symbol.asyncIterator]().next()
    void pending.catch(() => {})
    await Promise.resolve()
    let quiesced = false
    void lifecycle.quiesced.then(() => {
      quiesced = true
    })

    clientAbort.abort()
    await expect(pending).rejects.toThrow("Client disconnected")

    expect(returnStarted).toBe(true)
    expect(quiesced).toBe(false)
    releaseReturn()
    await lifecycle.quiesced
    expect(quiesced).toBe(true)
  })

  test("concurrent dispose calls share one cleanup and one result", async () => {
    let returnCalls = 0
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return new Promise(() => {})
          },
          async return(): Promise<IteratorResult<string>> {
            returnCalls++
            await returnGate
            return { done: true, value: undefined }
          },
        }
      },
    }
    const lifecycle = createDispatchLifecycle()
    lifecycle.ownFrames(source)

    const first = lifecycle.dispose("one")
    const second = lifecycle.dispose("two")
    await Promise.resolve()

    expect(first).toBe(second)
    expect(returnCalls).toBe(1)
    releaseReturn()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { quiesced: true, connectionReusable: true },
      { quiesced: true, connectionReusable: true },
    ])
  })

  /**
   * A4-4: `dispose()` used to resolve as soon as the body iterator was closed — a claim about OUR bookkeeping, not about the wire. The pooled connection could still be carrying a half-dead stream while the dispatch reported itself quiesced and reusable.
   * Both directions matter: the barrier must actually HOLD disposal, and it must not hold it forever.
   */
  test("disposal waits for the transport's physical close before reporting quiescence", async () => {
    const lifecycle = createDispatchLifecycle()
    let closeStream!: () => void
    lifecycle.registerTeardownBarrier({
      closed: new Promise<void>((resolve) => {
        closeStream = resolve
      }),
      graceMs: 5_000,
    })
    lifecycle.complete()

    let settled = false
    const disposal = lifecycle.dispose("test").then((result) => {
      settled = true
      return result
    })
    // Give the disposal every chance to resolve early; if the barrier were ignored it would.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    closeStream()
    await expect(disposal).resolves.toEqual({ quiesced: true, connectionReusable: true })
  })

  test("a stream that never closes stops being reusable instead of wedging teardown", async () => {
    const lifecycle = createDispatchLifecycle()
    let timedOut = 0
    lifecycle.registerTeardownBarrier({
      // Never resolves: the peer has stopped closing the stream.
      closed: new Promise<void>(() => {}),
      graceMs: 20,
      onTimeout: () => {
        timedOut += 1
      },
    })
    lifecycle.complete()

    // Not reusable is the load-bearing half: after the grace we no longer know the connection's
    // state, and handing it back to the pool would put the next request on a stream we cannot account for.
    await expect(lifecycle.dispose("test")).resolves.toEqual({ quiesced: true, connectionReusable: false })
    expect(timedOut).toBe(1)
  })

  test("without a registered barrier disposal behaves exactly as before", async () => {
    const lifecycle = createDispatchLifecycle()
    lifecycle.complete()

    // Transports that own no physical stream (and every pre-A4-4 caller) must be unaffected.
    await expect(lifecycle.dispose("test")).resolves.toEqual({ quiesced: true, connectionReusable: true })
  })
})

describe("per-attempt upstream deadline (timeouts.upstream_request_deadline)", () => {
  test("firing aborts the dispatch with an `upstream-request-deadline` cause, distinct from a plain dispatch-cancel", async () => {
    const lifecycle = createDispatchLifecycle(undefined, { deadlineMs: 20 })
    const { source } = pendingSource()
    lifecycle.ownFrames(source)

    expect(lifecycle.signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 60))

    expect(lifecycle.signal.aborted).toBe(true)
    // The cause must survive the dispose() -> cancel() path, which would otherwise re-tag it
    // `dispatch-cancel` and make an attempt timeout indistinguishable from a hedge-loser teardown.
    expect(getCancellationCause(lifecycle.signal.reason)).toBe("upstream-request-deadline")
    expect(String((lifecycle.signal.reason as Error).message)).toContain("upstream_request_deadline")
    await expect(lifecycle.quiesced).resolves.toBeUndefined()
  })

  test("a dispatch that completes before the deadline is never aborted and clears its timer", async () => {
    const lifecycle = createDispatchLifecycle(undefined, { deadlineMs: 40 })
    const frames = lifecycle.ownFrames(
      (async function* () {
        yield "frame"
      })(),
    )

    expect(await Array.fromAsync(frames)).toEqual(["frame"])
    await new Promise((r) => setTimeout(r, 80))

    expect(lifecycle.signal.aborted).toBe(false)
  })

  test("deadlineMs 0 arms nothing (byte-identical to the no-options path)", async () => {
    const lifecycle = createDispatchLifecycle(undefined, { deadlineMs: 0 })
    const { source } = pendingSource()
    lifecycle.ownFrames(source)

    await new Promise((r) => setTimeout(r, 60))

    expect(lifecycle.signal.aborted).toBe(false)
    await lifecycle.dispose()
  })
})
