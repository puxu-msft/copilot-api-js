/**
 * L2 buffered-retry hit-rate counter (protect-streaming-stats).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getProtectStreamingStats,
  recordProtectStreamingOutcome,
  resetProtectStreamingStatsForTests,
} from "~/lib/anthropic/protect-streaming-stats"

describe("protect-streaming-stats", () => {
  beforeEach(() => resetProtectStreamingStatsForTests())

  test("starts at zero", () => {
    expect(getProtectStreamingStats()).toEqual({ success: 0, exhausted: 0, retreated: 0, totalRetries: 0 })
  })

  test("accumulates per outcome + sums retries", () => {
    recordProtectStreamingOutcome("success", 2) // a save after 2 retries
    recordProtectStreamingOutcome("success", 0) // buffered with no RST (no save)
    recordProtectStreamingOutcome("exhausted", 3)
    recordProtectStreamingOutcome("retreated", 1)
    expect(getProtectStreamingStats()).toEqual({ success: 2, exhausted: 1, retreated: 1, totalRetries: 6 })
  })

  test("getter returns a snapshot copy (not the live object)", () => {
    recordProtectStreamingOutcome("success", 1)
    const snap = getProtectStreamingStats()
    recordProtectStreamingOutcome("success", 1)
    expect(snap.success).toBe(1) // unchanged by the later record
    expect(getProtectStreamingStats().success).toBe(2)
  })

  test("reset zeroes all counters", () => {
    recordProtectStreamingOutcome("success", 5)
    resetProtectStreamingStatsForTests()
    expect(getProtectStreamingStats()).toEqual({ success: 0, exhausted: 0, retreated: 0, totalRetries: 0 })
  })
})
