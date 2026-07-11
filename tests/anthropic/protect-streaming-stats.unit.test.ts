/**
 * L2 buffered-retry hit-rate counter (protect-streaming-stats).
 *
 * Post-block-level: the counter is keyed PER VENDOR (`Record<vendor, Stats>`), a new
 * `partialDegrade` terminal (a boundary block committed live, then the stream truncated)
 * is tracked with its `retriesBeforeDegrade` (the retries the engine consumed before the
 * degrade — so the "retry engine engaged" signal is never lost), and the hit-rate
 * denominator folds in `partialDegrade` (a partial success).
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
  protectStreamingHitRate,
  recordProtectStreamingOutcome,
  resetProtectStreamingStatsForTests,
} from "~/lib/anthropic/protect-streaming-stats"

describe("protect-streaming-stats", () => {
  beforeEach(() => resetProtectStreamingStatsForTests())

  test("starts empty (no vendor buckets)", () => {
    expect(getProtectStreamingStats()).toEqual({})
  })

  test("partial-degrade + vendor dimension counted per-vendor", () => {
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("partial-degrade", 2, { vendor: "responses" })
    const s = getProtectStreamingStats()
    expect(s.anthropic.success).toBe(1)
    expect(s.responses.partialDegrade).toBe(1)
    expect(s.responses.retriesBeforeDegrade).toBe(2) // retries consumed before the degrade
    // Cross-vendor isolation: anthropic never accrues a partial-degrade.
    expect(s.anthropic.partialDegrade).toBe(0)
    expect(s.anthropic.retriesBeforeDegrade).toBe(0)
  })

  test("accumulates per outcome + sums retries within a vendor bucket", () => {
    recordProtectStreamingOutcome("success", 2, { vendor: "anthropic" }) // a save after 2 retries
    recordProtectStreamingOutcome("success", 0, { vendor: "anthropic" }) // buffered with no RST (no save)
    recordProtectStreamingOutcome("exhausted", 3, { vendor: "anthropic" })
    recordProtectStreamingOutcome("retreated", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("partial-degrade", 4, { vendor: "anthropic" })
    expect(getProtectStreamingStats().anthropic).toEqual({
      success: 2,
      exhausted: 1,
      retreated: 1,
      partialDegrade: 1,
      totalRetries: 10, // 2 + 0 + 3 + 1 + 4
      retriesBeforeDegrade: 4, // only the partial-degrade leg
    })
  })

  test("totalRetries counts every leg; retriesBeforeDegrade ONLY the partial-degrade legs", () => {
    recordProtectStreamingOutcome("partial-degrade", 1, { vendor: "responses" })
    recordProtectStreamingOutcome("partial-degrade", 2, { vendor: "responses" })
    recordProtectStreamingOutcome("success", 5, { vendor: "responses" })
    const r = getProtectStreamingStats().responses
    expect(r.partialDegrade).toBe(2)
    expect(r.retriesBeforeDegrade).toBe(3) // 1 + 2, NOT the success's 5
    expect(r.totalRetries).toBe(8) // 1 + 2 + 5
  })

  test("hit-rate folds partial-degrade into the denominator (success / (success + exhausted + partialDegrade))", () => {
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("exhausted", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("partial-degrade", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("retreated", 1, { vendor: "anthropic" }) // retreated is OUTSIDE the hit-rate denominator
    // 2 / (2 + 1 + 1) = 0.5 — retreated excluded (it lost L2 protection, not a generation outcome).
    expect(protectStreamingHitRate(getProtectStreamingStats().anthropic)).toBe(0.5)
  })

  test("hit-rate is null when there are no denominator engagements", () => {
    recordProtectStreamingOutcome("retreated", 1, { vendor: "anthropic" })
    expect(protectStreamingHitRate(getProtectStreamingStats().anthropic)).toBeNull()
  })

  test("getter returns a deep snapshot copy (not the live objects)", () => {
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    const snap = getProtectStreamingStats()
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    expect(snap.anthropic.success).toBe(1) // unchanged by the later record
    expect(getProtectStreamingStats().anthropic.success).toBe(2)
  })

  test("reset clears all vendor buckets", () => {
    recordProtectStreamingOutcome("success", 5, { vendor: "anthropic" })
    recordProtectStreamingOutcome("success", 5, { vendor: "responses" })
    resetProtectStreamingStatsForTests()
    expect(getProtectStreamingStats()).toEqual({})
  })
})
