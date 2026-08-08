import {
  //
  describe,
  expect,
  test,
} from "bun:test"

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

  test.each([
    undefined,
    null,
    "cleanup string",
    Number.NaN,
  ])("preserves unknown cleanup rejection %#", async (cleanupError) => {
    const lifecycle = createDispatchLifecycle()
    let returnCalls = 0
    lifecycle.ownFrames({
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            returnCalls++
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
})
