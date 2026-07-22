import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  computeReaperIntervalMs,
  REAPER_INTERVAL_MAX_MS,
  REAPER_INTERVAL_MIN_MS,
} from "~/lib/context/manager"

// DI-7: the reaper scan interval is derived from `staleRequestMaxAge` (maxAge/3,
// clamped to [MIN, MAX]). Previously an un-exported closure with no boundary
// coverage; these lock the formula and both clamp edges.
describe("computeReaperIntervalMs", () => {
  test("maxAge <= 0 (disabled) → MAX", () => {
    expect(computeReaperIntervalMs(0)).toBe(REAPER_INTERVAL_MAX_MS)
    expect(computeReaperIntervalMs(-5)).toBe(REAPER_INTERVAL_MAX_MS)
  })

  test("mid-range → maxAge/3 (ms)", () => {
    expect(computeReaperIntervalMs(90)).toBe(30_000) // 90_000 / 3
    expect(computeReaperIntervalMs(1)).toBe(333) // floor(1000 / 3)
  })

  test("tiny maxAge clamps up to MIN floor", () => {
    // floor(500 / 3) = 166 < 250
    expect(computeReaperIntervalMs(0.5)).toBe(REAPER_INTERVAL_MIN_MS)
  })

  test("large maxAge clamps down to MAX cap", () => {
    // floor(750_000 / 3) = 250_000 > 60_000
    expect(computeReaperIntervalMs(750)).toBe(REAPER_INTERVAL_MAX_MS)
  })

  test("exact MAX boundary (maxAge = 180s → 60_000) is not over-clamped", () => {
    expect(computeReaperIntervalMs(180)).toBe(REAPER_INTERVAL_MAX_MS)
  })
})
