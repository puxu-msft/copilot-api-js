// engine.consumers.test.ts
import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  ensureModelLimits,
  factorAt,
  getLearnedLimits,
  onTokenLimitExceeded,
  resetAllLimitsForTesting,
} from "./engine"

afterEach(() => resetAllLimitsForTesting())

test("seed-only model has undefined tokenLimit → calculateTokenLimit falls back to capabilities", () => {
  ensureModelLimits("claude-opus-4.8") // seeded, no 400 yet
  expect(getLearnedLimits("claude-opus-4.8")?.tokenLimit).toBeUndefined()
})

test("N1: first 400 on a seeded model writes tokenLimit despite undefined start", () => {
  ensureModelLimits("claude-opus-4.8")
  onTokenLimitExceeded("claude-opus-4.8", 900_000, 950_000, 500_000)
  expect(getLearnedLimits("claude-opus-4.8")?.tokenLimit).toBe(900_000)
})

test("400 leg feeds learnCalibration into the size bucket (isLive)", () => {
  onTokenLimitExceeded("m", 900_000, 950_000, 480_000) // real 950k / est 480k ≈ 1.979, bucket5
  expect(factorAt("m", 480_000)).toBeCloseTo(1.979, 1)
  expect(getLearnedLimits("m")?.liveSampleCount).toBe(1)
})
