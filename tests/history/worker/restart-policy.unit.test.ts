import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { HistoryWorkerRestartPolicy } from "~/lib/history/worker/restart-policy"

/** Deterministic clock; the policy must never consult a real one for `nextRetryAt`. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

describe("History Worker restart policy", () => {
  test("doubles the delay per consecutive failure and stops at the cap", () => {
    const policy = new HistoryWorkerRestartPolicy({ initialDelayMs: 100, maxDelayMs: 800, now: clock().now })

    const delays = Array.from({ length: 6 }, () => policy.recordFailure().delayMs)

    expect(delays).toEqual([100, 200, 400, 800, 800, 800])
    expect(policy.consecutiveFailures).toBe(6)
  })

  test("reports nextRetryAt against the injected clock", () => {
    const time = clock(5_000)
    const policy = new HistoryWorkerRestartPolicy({ initialDelayMs: 250, maxDelayMs: 10_000, now: time.now })

    expect(policy.nextRetryAt).toBeUndefined()
    expect(policy.recordFailure().nextRetryAt).toBe(5_250)

    time.advance(1_000)
    expect(policy.recordFailure().nextRetryAt).toBe(6_500)
    expect(policy.nextRetryAt).toBe(6_500)
  })

  test("a ready generation clears the streak and the pending retry", () => {
    const policy = new HistoryWorkerRestartPolicy({ initialDelayMs: 100, maxDelayMs: 800, now: clock().now })
    policy.recordFailure()
    policy.recordFailure()

    policy.recordSuccess()

    expect(policy.consecutiveFailures).toBe(0)
    expect(policy.nextRetryAt).toBeUndefined()
    // The next crash starts from the initial delay again, not from where the old streak left off.
    expect(policy.recordFailure().delayMs).toBe(100)
  })

  test("a zero initial delay or zero cap means restart immediately", () => {
    const immediateInitial = new HistoryWorkerRestartPolicy({ initialDelayMs: 0, maxDelayMs: 800, now: clock().now })
    const immediateCap = new HistoryWorkerRestartPolicy({ initialDelayMs: 100, maxDelayMs: 0, now: clock().now })

    expect(immediateInitial.recordFailure().delayMs).toBe(0)
    expect(immediateCap.recordFailure().delayMs).toBe(0)
  })

  test("defaults are bounded without any options", () => {
    const policy = new HistoryWorkerRestartPolicy()

    const first = policy.recordFailure().delayMs
    const runaway = Array.from({ length: 40 }, () => policy.recordFailure().delayMs).at(-1)

    expect(first).toBeGreaterThan(0)
    expect(runaway).toBeLessThanOrEqual(30_000)
  })
})
