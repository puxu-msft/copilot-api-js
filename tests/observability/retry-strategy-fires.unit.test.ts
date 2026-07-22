/**
 * Task 5 (Commit 5) — per-strategy retry-fire telemetry counter (RFC 2026-07-21-retry-strategy-registry
 * §3.5 / plan Task 5).
 *
 * A tiny process-lifetime in-memory counter — mirrors `tool-input-repair-stats.ts` /
 * `protect-streaming-stats.ts` (a live-observation aggregate, resets on restart). Registered
 * `{strategy}` name is the retry-registry entry's `.name` (e.g. `network-retry`), NOT the configKey —
 * matches what `recordAttemptFailure({nextStrategy})` already records into history (same identifier
 * space, so `/metrics` and history line up on the same key).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getRetryStrategyFireCounts,
  recordRetryStrategyFire,
  resetRetryStrategyFiresForTests,
} from "~/lib/observability/retry-strategy-fires"

describe("retry-strategy-fires counter", () => {
  beforeEach(() => {
    resetRetryStrategyFiresForTests()
  })
  afterEach(() => {
    resetRetryStrategyFiresForTests()
  })

  test("starts empty", () => {
    expect(getRetryStrategyFireCounts()).toEqual({})
  })

  test("records one fire per call, keyed by strategy name", () => {
    recordRetryStrategyFire("network-retry")
    expect(getRetryStrategyFireCounts()).toEqual({ "network-retry": 1 })
  })

  test("accumulates repeated fires of the same strategy", () => {
    recordRetryStrategyFire("network-retry")
    recordRetryStrategyFire("network-retry")
    recordRetryStrategyFire("network-retry")
    expect(getRetryStrategyFireCounts()).toEqual({ "network-retry": 3 })
  })

  test("tracks distinct strategies independently (open bag — no fixed key set)", () => {
    recordRetryStrategyFire("network-retry")
    recordRetryStrategyFire("token-refresh")
    recordRetryStrategyFire("network-retry")
    expect(getRetryStrategyFireCounts()).toEqual({ "network-retry": 2, "token-refresh": 1 })
  })

  test("getRetryStrategyFireCounts returns a snapshot (mutating the returned object does not affect the live counter)", () => {
    recordRetryStrategyFire("network-retry")
    const snapshot = getRetryStrategyFireCounts() as Record<string, number>
    snapshot["network-retry"] = 999
    snapshot["injected"] = 1
    expect(getRetryStrategyFireCounts()).toEqual({ "network-retry": 1 })
  })

  test("resetRetryStrategyFiresForTests clears all counters", () => {
    recordRetryStrategyFire("network-retry")
    recordRetryStrategyFire("token-refresh")
    resetRetryStrategyFiresForTests()
    expect(getRetryStrategyFireCounts()).toEqual({})
  })
})
