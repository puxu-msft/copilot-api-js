// engine.consumers.test.ts
import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  factorAt,
  getLearnedLimits,
  learnCalibration,
  resetAllLimitsForTesting,
} from "./engine"

afterEach(() => resetAllLimitsForTesting())

test("learnCalibration feeds an (est, real) sample into the size bucket + bumps liveSampleCount", () => {
  learnCalibration("m", 480_000, 950_000, { isLive: true }) // real 950k / est 480k ≈ 1.979, top bucket
  expect(factorAt("m", 480_000)).toBeCloseTo(1.979, 1)
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(1)
})

test("non-live sample (seed/backfill) does NOT bump liveSampleCount", () => {
  learnCalibration("m", 20_000, 26_000, { isLive: false })
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(0)
})
