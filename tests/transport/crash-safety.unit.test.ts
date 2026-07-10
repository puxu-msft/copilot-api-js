/**
 * Unit tests for the crash-safety primitives (crash-safety.ts) — the three
 * class-elimination guards that keep benign escaped events off main.ts's
 * process.exit(1) global handlers. These test the primitives in isolation; the
 * end-to-end transport behaviour is covered in http2-client.it.test.ts.
 *
 * unicorn/prefer-event-target is disabled on purpose: withErrorSink guards
 * node:EventEmitter specifically — the "an unheard 'error' event is rethrown as
 * an uncaughtException" semantics under test are EventEmitter's, not
 * EventTarget's (which has no such behaviour). Using EventTarget for the
 * withErrorSink tests would test the wrong contract. (guardCallback's tests DO
 * use EventTarget — that is its actual domain, the EventTarget twin.)
 */
/* eslint-disable unicorn/prefer-event-target */

import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import {
  //
  guardCallback,
  withErrorSink,
  withRejectionObserver,
} from "~/lib/transport/crash-safety"

describe("withErrorSink", () => {
  test("an emitter with NO other 'error' listener does not throw on emit('error')", () => {
    const ee = withErrorSink(new EventEmitter())
    // Without the sink, Node rethrows an unheard 'error' synchronously here → the
    // whole process would crash via main.ts's uncaughtException handler.
    expect(() => ee.emit("error", new Error("boom"))).not.toThrow()
  })

  test("does NOT consume — a real 'error' listener still fires", () => {
    const ee = withErrorSink(new EventEmitter())
    const seen: Array<string> = []
    ee.on("error", (e: Error) => seen.push(e.message))
    ee.emit("error", new Error("real"))
    expect(seen).toEqual(["real"])
  })

  test("absorbs repeated 'error' emissions (uses .on, not .once)", () => {
    const ee = withErrorSink(new EventEmitter())
    expect(() => {
      ee.emit("error", new Error("first"))
      ee.emit("error", new Error("second"))
    }).not.toThrow()
  })

  test("returns the SAME emitter instance", () => {
    const ee = new EventEmitter()
    expect(withErrorSink(ee)).toBe(ee)
  })
})

describe("withRejectionObserver", () => {
  test("an orphaned rejection does not surface as a process unhandledRejection", async () => {
    const seen: Array<unknown> = []
    const onUnhandled = (reason: unknown): void => void seen.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      // Orphan: observed but never awaited/.catch'd by a real consumer.
      const orphan = withRejectionObserver(Promise.reject(new Error("orphan")))
      void orphan
      await new Promise((r) => setTimeout(r, 30))
      expect(seen).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("does NOT consume — a real awaiter still receives the rejection", async () => {
    const p = withRejectionObserver(Promise.reject(new Error("still thrown")))
    await expect(p).rejects.toThrow("still thrown")
  })

  test("returns the SAME promise instance", () => {
    const p = Promise.resolve(1)
    expect(withRejectionObserver(p)).toBe(p)
  })
})

describe("guardCallback", () => {
  test("forwards args and return-less call when fn does not throw", () => {
    const seen: Array<unknown> = []
    const onEscape = mock(() => {})
    const guarded = guardCallback((a: number, b: string) => {
      seen.push(a, b)
    }, onEscape)
    guarded(1, "x")
    expect(seen).toEqual([1, "x"])
    expect(onEscape).not.toHaveBeenCalled()
  })

  test("catches a synchronous throw, routes it to onEscape, and does not rethrow", () => {
    const err = new Error("boom")
    let captured: unknown = null
    const guarded = guardCallback(
      () => {
        throw err
      },
      (e) => {
        captured = e
      },
    )
    expect(() => guarded()).not.toThrow() // meaningful HERE: guardCallback itself must swallow
    expect(captured).toBe(err)
  })

  test("a throwing guarded EventTarget listener does not escape dispatchEvent", () => {
    // Locks the empirical model: without a guard the throw escapes as uncaughtException;
    // guarded, onEscape absorbs it and dispatchEvent completes cleanly.
    const target = new EventTarget()
    let escaped: unknown = null
    target.addEventListener(
      "x",
      guardCallback(
        () => {
          throw new Error("listener-boom")
        },
        (e) => {
          escaped = e
        },
      ),
    )
    expect(() => target.dispatchEvent(new Event("x"))).not.toThrow()
    expect(escaped).toBeInstanceOf(Error)
  })
})
