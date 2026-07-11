import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HistoryEntry } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"

import { countTotalTokens } from "~/lib/anthropic/auto-truncate"
import {
  //
  bucketIndexFor,
  getLearnedLimits,
  resetAllLimitsForTesting,
  setLearnedLimitsPathForTests,
} from "~/lib/auto-truncate"
import {
  //
  resetCalibrationBackfillForTests,
  runCalibrationBackfill,
  stopCalibrationBackfill,
} from "~/lib/history/sqlite/calibration-backfill"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  CALIBRATION_BACKFILL_CURSOR_KEY,
  CALIBRATION_BACKFILL_VERSION,
  CALIBRATION_BACKFILL_VERSION_KEY,
  getMeta,
} from "~/lib/history/sqlite/meta"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import { setStateForTests } from "~/lib/state"

// A minimal, UNSEEDED model (not in DEFAULT_FACTOR_SEED) — no `capabilities`, so
// countTotalTokens uses the default o200k_base tokenizer. Unseeded keeps the
// per-bucket oracle pure: backfill is the ONLY writer of these buckets.
const MODEL_ID = "claude-cal-backfill-test"
const TEST_MODEL: Model = {
  id: MODEL_ID,
  name: "Calibration Backfill Test",
  object: "model",
  vendor: "anthropic",
  version: "1",
  model_picker_enabled: true,
  preview: false,
  is_chat_default: false,
  is_chat_fallback: false,
}

interface UsageInput {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Build a completed anthropic-messages entry with a controllable wire body + usage. */
function calEntry(id: string, startedAt: number, opts: { body: unknown; usage: UsageInput; withUpstreamRequest: boolean }): HistoryEntry {
  const attempt: Record<string, unknown> = {
    index: 0,
    durationMs: 1,
    upstreamResponse: { success: true, usage: opts.usage },
  }
  if (opts.withUpstreamRequest) {
    attempt.upstreamRequest = { format: "anthropic-messages", body: opts.body }
  }
  return {
    id,
    startedAt,
    endpoint: "anthropic-messages",
    model: { requested: MODEL_ID, resolved: MODEL_ID },
    state: "completed",
    active: false,
    lastUpdatedAt: startedAt,
    durationMs: 1,
    attempts: [attempt],
  } as unknown as HistoryEntry
}

/** A body whose gpt-tokenizer estimate is large enough to clear the est<500 floor. */
function bodyOfChars(n: number): unknown {
  return { model: MODEL_ID, messages: [{ role: "user", content: "lorem ipsum ".repeat(Math.ceil(n / 12)) }] }
}

beforeEach(() => {
  resetCalibrationBackfillForTests()
  closeDatabase()
  openInMemoryDatabase()
  setStateForTests({ models: { object: "list", data: [TEST_MODEL] } })
  const dir = mkdtempSync(join(tmpdir(), "cal-backfill-"))
  setLearnedLimitsPathForTests(join(dir, "learned-limits.json"))
})

afterEach(() => {
  resetAllLimitsForTesting()
  setLearnedLimitsPathForTests(undefined)
  setStateForTests({ models: undefined })
  closeDatabase()
})

describe("calibration backfill", () => {
  test("aggregates tok-weighted factor per bucket, idempotently", async () => {
    const db = getDatabase()

    // Three entries with distinct body sizes + factors. Compute each est via the
    // SAME countTotalTokens the backfill uses, then set real = round(est*factor).
    const specs = [
      { id: "e1", chars: 240_000, factor: 1.4 },
      { id: "e2", chars: 240_000, factor: 1.6 },
      { id: "e3", chars: 40_000, factor: 1.3 },
    ]
    // Independent oracle: accumulate Σreal/Σest per bucket in the test itself.
    const expected = new Map<number, { sumReal: number; sumEst: number; count: number }>()
    let startedAt = 1000
    for (const s of specs) {
      const body = bodyOfChars(s.chars)
      const est = await countTotalTokens(body as never, TEST_MODEL)
      const real = Math.round(est * s.factor)
      const bucket = bucketIndexFor(est)
      const agg = expected.get(bucket) ?? { sumReal: 0, sumEst: 0, count: 0 }
      agg.sumReal += real
      agg.sumEst += est
      agg.count += 1
      expected.set(bucket, agg)
      await insertCompletedEntry(calEntry(s.id, startedAt++, { body, usage: { input_tokens: real, output_tokens: 1 }, withUpstreamRequest: true }))
    }

    await runCalibrationBackfill(db)

    const buckets = getLearnedLimits(MODEL_ID)?.factorModel.buckets
    expect(buckets).toBeDefined()
    for (const [idx, agg] of expected) {
      const b = buckets![idx]
      expect(b.sampleCount).toBe(agg.count)
      // factor = Σreal/Σest (scale cancels in the ratio).
      expect(b.sumReal / b.sumEst).toBeCloseTo(agg.sumReal / agg.sumEst, 4)
    }

    // Snapshot then re-run: the version guard short-circuits → identical buckets.
    const before = JSON.stringify(buckets)
    await runCalibrationBackfill(db)
    expect(JSON.stringify(getLearnedLimits(MODEL_ID)?.factorModel.buckets)).toBe(before)
    expect(getMeta(db, CALIBRATION_BACKFILL_VERSION_KEY)).toBe(CALIBRATION_BACKFILL_VERSION)
  })

  test("does NOT bump liveSampleCount (backfill is synthetic, not live)", async () => {
    const db = getDatabase()
    const body = bodyOfChars(240_000)
    const est = await countTotalTokens(body as never, TEST_MODEL)
    await insertCompletedEntry(calEntry("live1", 1000, { body, usage: { input_tokens: Math.round(est * 1.5), output_tokens: 1 }, withUpstreamRequest: true }))
    await runCalibrationBackfill(db)
    expect(getLearnedLimits(MODEL_ID)?.liveSampleCount).toBe(0)
  })

  test("skips legacy rows lacking an upstream_request stage", async () => {
    const db = getDatabase()
    // A valid (large) entry populates its bucket; a legacy (small) entry with NO
    // upstreamRequest leg must be skipped, leaving ITS bucket empty.
    const validBody = bodyOfChars(240_000)
    const validEst = await countTotalTokens(validBody as never, TEST_MODEL)
    const validBucket = bucketIndexFor(validEst)
    const legacyBody = bodyOfChars(40_000)
    const legacyEst = await countTotalTokens(legacyBody as never, TEST_MODEL)
    const legacyBucket = bucketIndexFor(legacyEst)
    expect(legacyBucket).not.toBe(validBucket) // distinct buckets so the assertion is meaningful

    await insertCompletedEntry(
      calEntry("valid1", 1000, { body: validBody, usage: { input_tokens: Math.round(validEst * 1.5), output_tokens: 1 }, withUpstreamRequest: true }),
    )
    await insertCompletedEntry(
      calEntry("legacy1", 1001, { body: legacyBody, usage: { input_tokens: Math.round(legacyEst * 1.9), output_tokens: 1 }, withUpstreamRequest: false }),
    )

    await runCalibrationBackfill(db)

    const buckets = getLearnedLimits(MODEL_ID)?.factorModel.buckets
    expect(buckets).toBeDefined()
    expect(buckets![validBucket].sampleCount).toBe(1) // valid entry aggregated
    expect(buckets![legacyBucket].sampleCount).toBe(0) // skipped entry never aggregated
    expect(getMeta(db, CALIBRATION_BACKFILL_VERSION_KEY)).toBe(CALIBRATION_BACKFILL_VERSION)
  })

  test("cooperative stop mid-run does not set the completion version", async () => {
    const db = getDatabase()
    for (let i = 0; i < 150; i++) {
      const body = bodyOfChars(240_000)
      await insertCompletedEntry(calEntry(`stop${i}`, 1000 + i, { body, usage: { input_tokens: 200_000, output_tokens: 1 }, withUpstreamRequest: true }))
    }
    const p = runCalibrationBackfill(db)
    stopCalibrationBackfill()
    await p
    expect(getMeta(db, CALIBRATION_BACKFILL_VERSION_KEY)).not.toBe(CALIBRATION_BACKFILL_VERSION)
    // Cursor advanced (progress persisted) so a resume picks up where it stopped.
    expect(getMeta(db, CALIBRATION_BACKFILL_CURSOR_KEY)).not.toBeNull()
  })

  test("never throws on an undecodable stage blob", async () => {
    const db = getDatabase()
    const body = bodyOfChars(240_000)
    await insertCompletedEntry(calEntry("bad1", 1000, { body, usage: { input_tokens: 200_000, output_tokens: 1 }, withUpstreamRequest: true }))
    // Corrupt the request_group stage blob so decodeStageRows throws for this entry.
    db.prepare("UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = 'request_group'").run(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), "bad1")
    await runCalibrationBackfill(db) // must not throw
    // Run completes; the bad row contributed nothing.
    expect(getMeta(db, CALIBRATION_BACKFILL_VERSION_KEY)).toBe(CALIBRATION_BACKFILL_VERSION)
  })
})
