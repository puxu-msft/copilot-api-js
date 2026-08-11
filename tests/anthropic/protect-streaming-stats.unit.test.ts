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
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      totalRetries: 10, // 2 + 0 + 3 + 1 + 4
      retriesBeforeDegrade: 4, // only the partial-degrade leg
      preFirstBlockRetries: 10, // all retries are pre-first-block (no continuation legs here)
      continuationRetries: 0,
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

  test("continuation split (§5.3): meta.continuationRetries splits totalRetries into pre-first-block vs continuation; continuation-exhausted is its own bucket", () => {
    // a save via continuation: 3 total retries, 2 of them AFTER the first block committed (continuation legs).
    recordProtectStreamingOutcome("success", 3, { vendor: "anthropic", continuationRetries: 2 })
    // continuation fired but ran out of budget → its own outcome bucket (distinct from partial-degrade).
    recordProtectStreamingOutcome("continuation-exhausted", 1, { vendor: "anthropic", continuationRetries: 1 })
    const s = getProtectStreamingStats().anthropic
    expect(s.continuationRetries).toBe(3) // 2 + 1
    expect(s.preFirstBlockRetries).toBe(1) // (3-2) + (1-1) = 1 — the transparent retries only
    expect(s.totalRetries).toBe(4) // preFirstBlock + continuation = 1 + 3
    expect(s.continuationExhausted).toBe(1)
    expect(s.partialDegrade).toBe(0) // continuation-exhausted is NOT counted as partial-degrade
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

  test("continuation-exhausted increments its own counter and counts in the hit-rate denominator", () => {
    recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("continuation-exhausted", 3, { vendor: "anthropic" })
    const s = getProtectStreamingStats().anthropic
    expect(s.continuationExhausted).toBe(1)
    // denominator = success(1) + exhausted(0) + partialDegrade(0) + continuationExhausted(1) = 2
    expect(protectStreamingHitRate(s)).toBe(0.5)
  })

  test("precontent recovery outcomes increment their dedicated counters", () => {
    recordProtectStreamingOutcome("precontent-recovery-success", 1, { vendor: "anthropic" })
    recordProtectStreamingOutcome("precontent-recovery-exhausted", 1, { vendor: "anthropic" })

    const s = getProtectStreamingStats().anthropic
    expect(s.precontentRecoverySuccess).toBe(1)
    expect(s.precontentRecoveryExhausted).toBe(1)
  })

  test("retries split into pre-first-block vs continuation counts (telemetry-architecture: finest factors)", () => {
    // 3 retries total, 2 of which were continuation retries (post-first-block)
    recordProtectStreamingOutcome("continuation-exhausted", 3, { vendor: "anthropic", continuationRetries: 2 })
    const s = getProtectStreamingStats().anthropic
    expect(s.totalRetries).toBe(3)
    expect(s.continuationRetries).toBe(2)
    expect(s.preFirstBlockRetries).toBe(1)
  })

  test("legacy callers (no continuationRetries) attribute all retries to pre-first-block", () => {
    recordProtectStreamingOutcome("exhausted", 3, { vendor: "responses" })
    const s = getProtectStreamingStats().responses
    expect(s.continuationRetries).toBe(0)
    expect(s.preFirstBlockRetries).toBe(3)
  })
})
