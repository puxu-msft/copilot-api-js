/**
 * Unit tests for bridgeClientAbort — the helper that wires Hono's inbound
 * `c.req.raw.signal` (client disconnected) into a downstream AbortController.
 *
 * Covers the lifecycle invariants the upper layers rely on:
 *  - normal completion (no disconnect) — listener removed on detach()
 *  - inbound abort fires → downstream controller aborts exactly once
 *  - already-aborted inbound — synchronously aborts downstream, returns no-op
 *  - missing raw.signal (defensive) — returns no-op, no throw
 *  - detach() is idempotent
 */

import type { Context } from "hono"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { bridgeClientAbort } from "~/lib/abort-bridge"

/** Build a minimal Hono-context shaped object exposing only `req.raw.signal`. */
function mockContext(signal: AbortSignal | undefined): Context {
  return {
    req: {
      raw: { signal } as unknown as Request,
    },
  } as unknown as Context
}

describe("bridgeClientAbort", () => {
  test("aborts downstream when inbound signal aborts", () => {
    const inbound = new AbortController()
    const downstream = new AbortController()
    const c = mockContext(inbound.signal)

    bridgeClientAbort(c, downstream)
    expect(downstream.signal.aborted).toBe(false)

    inbound.abort()
    expect(downstream.signal.aborted).toBe(true)
  })

  test("synchronously aborts downstream when inbound is already aborted", () => {
    const inbound = new AbortController()
    inbound.abort()
    const downstream = new AbortController()
    const c = mockContext(inbound.signal)

    const cleanup = bridgeClientAbort(c, downstream)

    expect(downstream.signal.aborted).toBe(true)
    // cleanup is a no-op in this branch — calling it must not throw
    expect(() => cleanup()).not.toThrow()
  })

  test("detach() removes the listener so downstream is NOT aborted on later inbound abort", () => {
    const inbound = new AbortController()
    const downstream = new AbortController()
    const c = mockContext(inbound.signal)

    const cleanup = bridgeClientAbort(c, downstream)
    cleanup()
    inbound.abort()

    expect(downstream.signal.aborted).toBe(false)
  })

  test("returns a no-op when raw.signal is undefined (defensive)", () => {
    const downstream = new AbortController()
    const c = mockContext(undefined)

    const cleanup = bridgeClientAbort(c, downstream)
    expect(() => cleanup()).not.toThrow()
    expect(downstream.signal.aborted).toBe(false)
  })

  test("cleanup is idempotent — calling twice does not throw", () => {
    const inbound = new AbortController()
    const downstream = new AbortController()
    const c = mockContext(inbound.signal)

    const cleanup = bridgeClientAbort(c, downstream)
    cleanup()
    expect(() => cleanup()).not.toThrow()
  })

  test("downstream.abort fires only once per inbound abort (once: true semantics)", () => {
    const inbound = new AbortController()
    const downstream = new AbortController()
    const c = mockContext(inbound.signal)

    let abortCount = 0
    downstream.signal.addEventListener("abort", () => {
      abortCount++
    })

    bridgeClientAbort(c, downstream)
    inbound.abort()
    // A second inbound.abort() is a no-op on AbortController per spec, but
    // we still want to assert our bridge doesn't add multiple listeners.
    inbound.abort()

    expect(abortCount).toBe(1)
  })
})
