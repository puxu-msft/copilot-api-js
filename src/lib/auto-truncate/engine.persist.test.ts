// src/lib/auto-truncate/engine.persist.test.ts
import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  factorAt,
  getLearnedLimits,
  loadPersistedLimits,
  resetAllLimitsForTesting,
  seedFactorModel,
  setLearnedLimitsPathForTests,
} from "./engine"

afterEach(() => {
  resetAllLimitsForTesting()
  setLearnedLimitsPathForTests(undefined)
})

test("seedFactorModel populates opus-4.8 buckets with factor+meanEst", () => {
  const fm = seedFactorModel("claude-opus-4.8")
  expect(fm.buckets[3].sampleCount).toBeGreaterThan(0) // [60k,120k) seeded
  expect(fm.buckets[3].meanEst).toBeCloseTo(85_238, -2) // anchor x shipped
  expect(fm.buckets[0].sampleCount).toBe(0) // [0,15k) null → empty
})

test("v1 file migrates: scalar → max bucket, sampleCount → liveSampleCount", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-"))
  const path = join(dir, "learned-limits.json")
  // A v1 model WITHOUT a seed entry — scalar lands in the top bucket only.
  writeFileSync(
    path,
    JSON.stringify({ version: 1, limits: { "claude-mystery": { tokenLimit: 900_000, calibrationFactor: 2.2, sampleCount: 40, updatedAt: 1 } } }),
  )
  setLearnedLimitsPathForTests(path)
  await loadPersistedLimits()
  const lim = getLearnedLimits("claude-mystery")
  expect(lim?.liveSampleCount).toBe(40)
  expect(lim?.tokenLimit).toBe(900_000)
  expect(factorAt("claude-mystery", 400_000)).toBeCloseTo(2.2, 1) // top bucket
})
