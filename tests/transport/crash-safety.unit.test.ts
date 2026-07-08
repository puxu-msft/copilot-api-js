/**
 * Unit tests for the crash-safety primitives (crash-safety.ts) — the two
 * class-elimination guards that keep benign escaped events off main.ts's
 * process.exit(1) global handlers. These test the primitives in isolation; the
 * end-to-end transport behaviour is covered in http2-client.it.test.ts.
 *
 * unicorn/prefer-event-target is disabled on purpose: withErrorSink guards
 * node:EventEmitter specifically — the "an unheard 'error' event is rethrown as
 * an uncaughtException" semantics under test are EventEmitter's, not
 * EventTarget's (which has no such behaviour). Using EventTarget here would test
 * the wrong contract.
 */
/* eslint-disable unicorn/prefer-event-target */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import {
  //
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
