/**
 * Unit tests for the upstream HTTP/2 PING keepalive scheduler
 * (`scheduleH2KeepalivePing`). Pure scheduler logic — a fake session with a
 * `ping` spy + a real short interval, so it is deterministic without an h2
 * server or fake timers (Bun's h2 server does not surface received PINGs, and
 * fake-timer + setInterval is fragile under Bun — see skill bun-upstream-transport).
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("scheduleH2KeepalivePing", () => {
  test("pings on the given cadence until cleared", async () => {
    const ping = mock((cb: () => void) => cb())
    const timer = scheduleH2KeepalivePing(fakeSession(ping), 15)
    expect(timer).toBeDefined()

    await sleep(55) // ~3 intervals
    const afterRun = ping.mock.calls.length
    expect(afterRun).toBeGreaterThanOrEqual(2)

    clearInterval(timer)
    await sleep(40)
    // No further pings after clear.
    expect(ping.mock.calls.length).toBe(afterRun)
  })

  test("intervalMs <= 0 disables it (no timer, no ping)", async () => {
    const ping = mock((cb: () => void) => cb())
    expect(scheduleH2KeepalivePing(fakeSession(ping), 0)).toBeUndefined()
    expect(scheduleH2KeepalivePing(fakeSession(ping), -5)).toBeUndefined()
    await sleep(30)
    expect(ping.mock.calls.length).toBe(0)
  })

  test("a ping throwing (session half-closed) does not propagate or stop the timer", async () => {
    let calls = 0
    const ping = mock(() => {
      calls++
      throw new Error("ERR_HTTP2_INVALID_SESSION")
    })
    const timer = scheduleH2KeepalivePing(fakeSession(ping as unknown as (cb: () => void) => void), 15)
    await sleep(55)
    // Still ticking despite each ping throwing — the scheduler swallows it.
    expect(calls).toBeGreaterThanOrEqual(2)
    clearInterval(timer)
  })
})
