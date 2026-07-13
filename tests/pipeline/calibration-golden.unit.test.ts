import { beforeEach, describe, expect, test } from "bun:test"

import {
  //
  calibrate,
  ensureModelLimits,
  factorAt,
  learnCalibration,
  resetAllLimitsForTesting,
} from "~/lib/auto-truncate"

/**
 * Golden-fixture equivalence oracle captured BEFORE the auto-truncate removal.
 * The calibration factor model is retained (repurposed for honest local token
 * counting), so these `factorAt` / `calibrate` outputs MUST stay identical after
 * the truncation body is stripped. A drift here means the removal touched
 * calibration behavior it shouldn't have.
 */
describe("calibration golden (pre-removal equivalence oracle)", () => {
  beforeEach(() => resetAllLimitsForTesting())

  test("empty/unlearned model → identity (factorAt 1.0)", () => {
    expect(calibrate("unknown-model", 12345)).toBe(12345)
    expect(factorAt("unknown-model", 12345)).toBe(1.0)
  })

  test("learned samples produce deterministic per-bucket factor", () => {
    ensureModelLimits("m")
    learnCalibration("m", 20000, 26000, { isLive: true }) // bucket [15k,30k)
    learnCalibration("m", 50000, 66000, { isLive: true }) // bucket [30k,60k)
    // est=20000 sits at the lowest populated anchor → factor = 26000/20000 = 1.3
    expect(factorAt("m", 20000)).toBeCloseTo(1.3, 5)
    expect(calibrate("m", 20000)).toBe(26000) // ceil(20000 * 1.3)
  })

  test("opus-4.8 factory seed materializes interpolated factor", () => {
    // ensureModelLimits installs DEFAULT_FACTOR_SEED for opus-4.8; the bucket-2
    // anchor is { factor: 1.313, meanEst: 48784 }.
    ensureModelLimits("claude-opus-4.8")
    expect(factorAt("claude-opus-4.8", 48784)).toBeCloseTo(1.313, 2)
  })
})
