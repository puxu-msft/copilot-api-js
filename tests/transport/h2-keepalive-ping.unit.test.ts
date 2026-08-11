/**
 * Unit tests for the upstream HTTP/2 PING keepalive scheduler
 * (`scheduleH2KeepalivePing`). Pure scheduler logic — a fake session with a
 * `ping` spy + an injected manual interval scheduler, so it is deterministic
 * without an h2 server, wall-clock sleeps, or fake timers (Bun's h2 server does
 * not surface received PINGs — see skill debugging-ghc-api-upstream-transport).
 *
 * Why this exists: GHC's CAPI proxy does not forward Anthropic's SSE `ping`
 * frames, so a long thinking silence is a truly idle upstream stream that a
 * connection-idle reaper severs WITHOUT `message_stop`. Periodic h2 PING puts
 * real frames on the wire during that silence.
 */

import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { scheduleH2KeepalivePing } from "~/lib/transport/http2-client"

/** Minimal stand-in for the one method the scheduler touches. */
function fakeSession(ping: (cb: () => void) => void): Parameters<typeof scheduleH2KeepalivePing>[0] {
  return { ping } as unknown as Parameters<typeof scheduleH2KeepalivePing>[0]
}

function manualInterval(): {
  schedule: NonNullable<Parameters<typeof scheduleH2KeepalivePing>[2]>
  tick: () => void
  clear: () => void
  delayMs: () => number | undefined
  unref: ReturnType<typeof mock>
} {
  let callback: (() => void) | undefined
  let delay: number | undefined
  const unref = mock(() => {})
  return {
    schedule(next, delayMs) {
      callback = next
      delay = delayMs
      return { unref } as unknown as NodeJS.Timeout
    },
    tick: () => callback?.(),
    clear: () => {
      callback = undefined
    },
    delayMs: () => delay,
    unref,
  }
}

describe("scheduleH2KeepalivePing", () => {
  test("passes the configured cadence, unreferences the timer, and pings repeatedly until cleared", () => {
    const ping = mock((cb: () => void) => cb())
    const interval = manualInterval()
    const timer = scheduleH2KeepalivePing(fakeSession(ping), 15, interval.schedule)

    expect(timer).toBeDefined()
    expect(interval.delayMs()).toBe(15)
    expect(interval.unref).toHaveBeenCalledTimes(1)
    interval.tick()
    interval.tick()
    expect(ping).toHaveBeenCalledTimes(2)

    interval.clear()
    interval.tick()
    expect(ping).toHaveBeenCalledTimes(2)
  })

  test("intervalMs <= 0 disables it (no timer, no ping)", () => {
    const ping = mock((cb: () => void) => cb())
    const interval = manualInterval()

    expect(scheduleH2KeepalivePing(fakeSession(ping), 0, interval.schedule)).toBeUndefined()
    expect(scheduleH2KeepalivePing(fakeSession(ping), -5, interval.schedule)).toBeUndefined()
    interval.tick()
    expect(ping).toHaveBeenCalledTimes(0)
    expect(interval.unref).toHaveBeenCalledTimes(0)
  })

  test("a ping throwing (session half-closed) does not propagate or stop the timer", () => {
    const ping = mock(() => {
      throw new Error("ERR_HTTP2_INVALID_SESSION")
    })
    const interval = manualInterval()
    scheduleH2KeepalivePing(fakeSession(ping as unknown as (cb: () => void) => void), 15, interval.schedule)

    expect(() => interval.tick()).not.toThrow()
    expect(() => interval.tick()).not.toThrow()
    expect(ping).toHaveBeenCalledTimes(2)
  })
})
