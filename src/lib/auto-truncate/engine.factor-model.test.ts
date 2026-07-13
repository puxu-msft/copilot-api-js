import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  bucketIndexFor,
  factorAt,
  getLearnedLimits,
  learnCalibration,
  resetAllLimitsForTesting,
  WEIGHT_CAP,
} from "./engine"

afterEach(() => resetAllLimitsForTesting())

describe("bucketIndexFor", () => {
  test("maps estimate to the right bucket", () => {
    expect(bucketIndexFor(0)).toBe(0) // [0,15k)
    expect(bucketIndexFor(14_999)).toBe(0)
    expect(bucketIndexFor(15_000)).toBe(1) // [15k,30k)
    expect(bucketIndexFor(85_000)).toBe(3) // [60k,120k)
    expect(bucketIndexFor(5_000_000)).toBe(5) // [240k,inf)
  })
})

describe("factorAt", () => {
  test("empty model → 1.0 (no-op)", () => {
    expect(factorAt("unknown-model", 50_000)).toBe(1.0)
  })
  // NOTE: 插值（多锚点）测试在 Task 2（需 learnCalibration 建锚点）。本 task 只验空模型分支。
})

describe("learnCalibration", () => {
  test("learnCalibration accumulates tok-weighted factor in the right bucket", () => {
    learnCalibration("m", 80_000, 112_000, { isLive: true }) // factor 1.4, bucket3
    expect(factorAt("m", 80_000)).toBeCloseTo(1.4, 2)
    learnCalibration("m", 100_000, 160_000, { isLive: true }) // factor 1.6, same bucket3
    // tok-weighted mean = (112k+160k)/(80k+100k) = 272/180 ≈ 1.511
    expect(factorAt("m", 90_000)).toBeCloseTo(1.511, 2)
  })

  test("log-interpolates between adjacent populated bucket anchors (moved from Task 1, P-Y2)", () => {
    learnCalibration("m", 85_238, Math.round(85_238 * 1.434), { isLive: true }) // bucket3 anchor
    learnCalibration("m", 163_889, Math.round(163_889 * 1.625), { isLive: true }) // bucket4 anchor
    expect(factorAt("m", 50_000)).toBeCloseTo(1.434, 2) // below first anchor → clamp
    expect(factorAt("m", 300_000)).toBeCloseTo(1.625, 2) // above last anchor → clamp
    const mid = Math.exp((Math.log(85_238) + Math.log(163_889)) / 2)
    const f = factorAt("m", mid)
    expect(f).toBeGreaterThan(1.434)
    expect(f).toBeLessThan(1.625)
  })

  test("clamps factor to [0.5, 3.0]", () => {
    learnCalibration("m", 10_000, 100_000, { isLive: true }) // raw 10.0 → clamp 3.0
    expect(factorAt("m", 10_000)).toBeCloseTo(3.0, 2)
  })

  test("isLive:false does not bump liveSampleCount (margin source)", () => {
    learnCalibration("m", 80_000, 112_000, { isLive: false })
    expect(getLearnedLimits("m")?.liveSampleCount).toBe(0)
    learnCalibration("m", 80_000, 112_000, { isLive: true })
    expect(getLearnedLimits("m")?.liveSampleCount).toBe(1)
  })

  test("sliding window caps weight at WEIGHT_CAP", () => {
    for (let i = 0; i < WEIGHT_CAP + 500; i++) learnCalibration("m", 80_000, 112_000, { isLive: true })
    expect(getLearnedLimits("m")!.factorModel.buckets[3].sampleCount).toBe(WEIGHT_CAP)
  })
})
