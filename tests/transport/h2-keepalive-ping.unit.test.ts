/**
 * Unit tests for the upstream HTTP/2 PING keepalive scheduler
 * (`scheduleH2KeepalivePing`). Pure scheduler logic — a fake session with a
 * `ping` spy + event-driven waits for the observed calls. Bun's h2 server does
 * not surface received PINGs, and fake-timer + setInterval is fragile under Bun
 * (see skill debugging-ghc-api-upstream-transport).
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function waitForCalls(target: number, invoke: (onCall: () => void) => NodeJS.Timeout | undefined): Promise<NodeJS.Timeout> {
  return new Promise((resolve, reject) => {
    let calls = 0
    const timer = invoke(() => {
      calls++
      if (calls !== target) return
      if (timer) resolve(timer)
      else reject(new Error("scheduler did not return a timer"))
    })
  })
}

describe("scheduleH2KeepalivePing", () => {
  test("passes the configured cadence to the interval scheduler", () => {
    let scheduledDelay: number | undefined
    const timer = { unref: mock(() => {}) } as unknown as NodeJS.Timeout
    const schedule = mock((_callback: () => void, delay: number) => {
      scheduledDelay = delay
      return timer
    })

    expect(
      scheduleH2KeepalivePing(
        fakeSession(() => {}),
        15,
        schedule,
      ),
    ).toBe(timer)
    expect(scheduledDelay).toBe(15)
    expect(timer.unref).toHaveBeenCalledTimes(1)
  })

  test("pings repeatedly until cleared", async () => {
    const ping = mock((cb: () => void) => cb())
    const timer = await waitForCalls(2, (onCall) =>
      scheduleH2KeepalivePing(
        fakeSession((cb) => {
          ping(cb)
          onCall()
        }),
        15,
      ),
    )
    const afterRun = ping.mock.calls.length

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
    const ping = mock(() => {
      throw new Error("ERR_HTTP2_INVALID_SESSION")
    })
    const timer = await waitForCalls(2, (onCall) =>
      scheduleH2KeepalivePing(
        fakeSession(() => {
          try {
            ping()
          } finally {
            onCall()
          }
        }),
        15,
      ),
    )
    // Reaching the second call proves the first throw did not stop the interval.
    expect(ping).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })
})
