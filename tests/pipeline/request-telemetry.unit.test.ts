import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  TELEMETRY_HISTOGRAMS,
} from "~/lib/request-telemetry"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import {
  //
  _projectDimBucketsForTests,
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  getDimensionBreakdown,
  getRequestTelemetrySnapshot,
  getThinkingBlockTotals,
  initRequestTelemetry,
  persistRequestTelemetry,
  recordAcceptedRequest,
  recordSettledRequest,
} from "~/lib/telemetry-testing"

let tempDir: string
let telemetryFile: string
let dbPath: string
let stateSnapshot: StateSnapshot

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "request-telemetry-test-"))
  telemetryFile = path.join(tempDir, "request-telemetry.json")
  dbPath = path.join(tempDir, "telemetry.db")
  stateSnapshot = snapshotStateForTests()
  // P7 single-track: the 7d window rebuilds from SQLite (tel_raw) across restarts, so an isolated
  // per-test telemetry.db path is required for the restart oracles. telemetryCumulative on for parity.
  setStateForTests({ telemetryEnabled: true, telemetryDbPath: dbPath, telemetryCumulative: true })
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(telemetryFile)
})

afterEach(async () => {
  _resetRequestTelemetryForTests()
  restoreStateForTests(stateSnapshot)
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("request telemetry", () => {
  test("tracks accepted requests in filled 5-minute buckets across the rolling window", () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0)
    const oldTimestamp = now - 8 * 24 * 60 * 60 * 1000
    const recentTimestamp = now - 10 * 60 * 1000

    recordAcceptedRequest(oldTimestamp)
    recordAcceptedRequest(recentTimestamp)
    recordAcceptedRequest(now)

    const snapshot = getRequestTelemetrySnapshot(now)

    expect(snapshot.acceptedSinceStart).toBe(3)
    expect(snapshot.bucketSizeMinutes).toBe(5)
    expect(snapshot.windowDays).toBe(7)
    expect(snapshot.buckets).toHaveLength((7 * 24 * 60) / 5)
    expect(snapshot.totalLast7d).toBe(2)
    expect(snapshot.buckets.at(-1)?.count).toBe(1)
  })

  test("aggregates per-model request counts, duration, and token usage", () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0)
    recordSettledRequest(
      { model: "claude-sonnet-4.6" },
      {
        startedAt: now,
        endedAt: now + 1_500,
        success: true,
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    )
    recordSettledRequest(
      { model: "claude-sonnet-4.6" },
      {
        startedAt: now + 301_000,
        endedAt: now + 302_000,
        success: false,
        usage: {
          input_tokens: 20,
          output_tokens: 0,
        },
      },
    )

    const snapshot = getRequestTelemetrySnapshot(now + 302_000)
    expect(snapshot.modelsSinceStart).toHaveLength(1)
    expect(snapshot.modelsLast7d).toHaveLength(1)
    expect(snapshot.modelsSinceStart[0]).toEqual({
      model: "claude-sonnet-4.6",
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      totalDurationMs: 2_500,
      averageDurationMs: 1_250,
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        reasoningTokens: 12,
      },
    })
    expect(snapshot.modelsLast7d[0]).toEqual({
      model: "claude-sonnet-4.6",
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      totalDurationMs: 2_500,
      averageDurationMs: 1_250,
      buckets: [
        {
          timestamp: now,
          requestCount: 1,
          successCount: 1,
          failureCount: 0,
          totalDurationMs: 1_500,
          averageDurationMs: 1_500,
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            reasoningTokens: 12,
          },
        },
        {
          timestamp: now + 300_000,
          requestCount: 1,
          successCount: 0,
          failureCount: 1,
          totalDurationMs: 1_000,
          averageDurationMs: 1_000,
          usage: {
            inputTokens: 20,
            outputTokens: 0,
            totalTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
          },
        },
      ],
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        reasoningTokens: 12,
      },
    })
  })

  test("persists rolling buckets and 7d model stats but resets since-start counters on restart", async () => {
    // Use a recent timestamp (relative to real Date.now()) so the data stays
    // inside the 7-day retention window when initRequestTelemetry() re-loads
    // and calls pruneBuckets() against the wall clock on restart.
    const now = Date.now()

    // init opens telemetry.db so the dual-write feeds the outbox; persist drains it to SQLite (the sole
    // persistent store under P7 single-track). The restart then REBUILDS the 7d window from tel_raw.
    await initRequestTelemetry()
    recordAcceptedRequest(now)
    recordSettledRequest(
      { model: "gpt-5.2" },
      {
        startedAt: now,
        endedAt: now + 500,
        success: true,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      },
    )
    await persistRequestTelemetry()

    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()

    const snapshot = getRequestTelemetrySnapshot(now)
    expect(snapshot.totalLast7d).toBe(1)
    expect(snapshot.acceptedSinceStart).toBe(0)
    expect(snapshot.modelsSinceStart).toHaveLength(0)
    expect(snapshot.modelsLast7d).toHaveLength(1)
    const bucketTimestamp = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    expect(snapshot.modelsLast7d[0]).toMatchObject({
      model: "gpt-5.2",
      requestCount: 1,
      buckets: [
        {
          timestamp: bucketTimestamp,
          requestCount: 1,
        },
      ],
      usage: {
        totalTokens: 15,
      },
    })
  })

  test("concurrent persists serialize and drain to SQLite without loss (single-track)", async () => {
    const now = Date.now()
    await initRequestTelemetry()
    for (let i = 0; i < 50; i++) {
      recordSettledRequest(
        { model: `model-${i % 3}` },
        {
          startedAt: now - i,
          endedAt: now,
          success: true,
          usage: { input_tokens: i, output_tokens: i * 2 },
        },
      )
    }

    // Fire many persists in parallel — the periodic timer and shutdown can race in production. The
    // serialized flush + outbox snapshot-and-swap must drain to SQLite exactly once (no double-count,
    // no torn state). The legacy JSON write path is gone, so the only durable store is telemetry.db.
    await Promise.all(Array.from({ length: 25 }, () => persistRequestTelemetry()))

    // No JSON file is ever written under the single-track convergence.
    await expect(fs.access(telemetryFile)).rejects.toThrow()

    // Re-init rebuilds the 7d window from telemetry.db → state survives.
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()
    const snapshot = getRequestTelemetrySnapshot(now)
    expect(snapshot.modelsLast7d.length).toBe(3)
    // Exactly-once drain: total request count across the 3 models is 50 (no double-count from 25 flushes).
    const totalRequests = snapshot.modelsLast7d.reduce((sum, m) => sum + m.requestCount, 0)
    expect(totalRequests).toBe(50)
  })

  test("corrupted telemetry file is quarantined and starts fresh", async () => {
    await fs.writeFile(telemetryFile, "{not valid json", "utf8")

    await initRequestTelemetry()

    // Fresh state
    const snapshot = getRequestTelemetrySnapshot(Date.now())
    expect(snapshot.totalLast7d).toBe(0)
    expect(snapshot.modelsLast7d).toHaveLength(0)

    // Original corrupted file is gone; a `.corrupted.<ts>` sibling exists.
    const siblings = await fs.readdir(tempDir)
    expect(siblings.some((name) => name.includes(".corrupted."))).toBe(true)
    expect(siblings).not.toContain(path.basename(telemetryFile))
  })

  test("rebuild-equivalence oracle: dual-write → persist → restart rebuilds dimBuckets counters + series byte-equal (histograms empty)", async () => {
    // T7.1 承重 oracle: the 7d window rebuilt from SQLite tel_raw must reproduce the in-memory dimBuckets
    // counters + series EXACTLY (byte-for-byte per field). Independent oracle: capture the pre-restart
    // getDimensionBreakdown across MULTIPLE dimensions, restart (rebuild from SQLite), compare field-by-field.
    const now = Date.now()
    await initRequestTelemetry()

    const bucketMs = 5 * 60 * 1000
    // Spread requests across 3 buckets × multiple dims/keys so the rebuild must restore a sparse
    // multi-bucket multi-dimension structure (not just one flat aggregate).
    for (let b = 0; b < 3; b++) {
      const at = now - b * bucketMs
      for (let i = 0; i < 5; i++) {
        recordSettledRequest(
          { model: `m${i % 2}`, endpoint: "anthropic-messages", agentKind: i % 2 === 0 ? "main" : "subagent" },
          {
            startedAt: at,
            endedAt: at + 100 + i,
            success: i % 3 !== 0,
            multiplier: 3,
            usage: { input_tokens: 10 * (i + 1), output_tokens: 4 * (i + 1), cache_read_input_tokens: i },
          },
        )
      }
    }
    await persistRequestTelemetry()

    // Capture the pre-restart breakdowns (the ground truth to reproduce).
    const dims = ["model", "endpoint", "agentKind"] as const
    const before = Object.fromEntries(dims.map((d) => [d, getDimensionBreakdown(d, "7d", 100, now)]))

    // Restart: reset process state, rebuild from tel_raw.
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()

    for (const d of dims) {
      const after = getDimensionBreakdown(d, "7d", 100, now)
      // counters + series reproduce EXACTLY (independent field-by-field, not a self-consistency check).
      expect(after.totalKeys).toBe(before[d].totalKeys)
      expect(after.keys.map((k) => k.key).sort()).toEqual(before[d].keys.map((k) => k.key).sort())
      for (const key of after.keys) {
        const priorKey = before[d].keys.find((k) => k.key === key.key)!
        expect(key.counters).toEqual(priorKey.counters)
        expect(key.series).toEqual(priorKey.series)
        // 7d histograms are retired → empty stub (both before AND after — never populated for dimBuckets).
        expect(key.histograms).toEqual({})
        expect(priorKey.histograms).toEqual({})
      }
    }
  })
})

/**
 * Inspect the raw per-dimension per-bucket counters directly from the in-memory `dimBuckets` (the
 * snapshot surface only projects `model`). P7 removed the JSON write path, so this reads the in-memory
 * projection hook instead of persisting + re-reading a file. Kept async for call-site churn minimalism.
 */
async function persistedDimensions(): Promise<Record<string, { buckets: Record<string, Record<string, Record<string, number>>> }>> {
  return _projectDimBucketsForTests()
}

describe("dimension/measure framework", () => {
  test("accumulates generation candidate and physical dispatch counters", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    recordSettledRequest(
      { model: "claude-opus-4.8" },
      {
        startedAt: now,
        endedAt: now + 1,
        success: true,
        generation: {
          candidates: 2,
          dispatches: 3,
          hedgeCandidates: 1,
          hedgeWins: 1,
          recoveryCandidates: 0,
          cancelledDispatches: 1,
          unknownUsageDispatches: 1,
        },
      },
    )

    const dimensions = await persistedDimensions()
    expect(dimensions.model?.buckets[String(bucketTs)]?.["claude-opus-4.8"]).toMatchObject({
      generationCandidates: 2,
      upstreamDispatches: 3,
      hedgeCandidates: 1,
      hedgeWins: 1,
      recoveryCandidates: 0,
      cancelledDispatches: 1,
      unknownUsageDispatches: 1,
    })
  })

  test("accumulates multiple dimensions for one request (model + endpoint + agentKind)", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    recordSettledRequest(
      { model: "claude-opus-4.8", endpoint: "anthropic-messages", agentKind: "subagent" },
      { startedAt: now, endedAt: now + 100, success: true, usage: { input_tokens: 10, output_tokens: 4 } },
    )
    const dims = await persistedDimensions()
    expect(dims.model.buckets[String(bucketTs)]["claude-opus-4.8"].requestCount).toBe(1)
    expect(dims.endpoint.buckets[String(bucketTs)]["anthropic-messages"].inputTokens).toBe(10)
    expect(dims.agentKind.buckets[String(bucketTs)].subagent.outputTokens).toBe(4)
  })

  test("multi-key dimension accumulates once per DISTINCT key (deduped)", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    recordSettledRequest(
      { tool: ["Read", "Bash", "Read"] }, // duplicate Read → counted once
      { startedAt: now, endedAt: now + 50, success: true, usage: { input_tokens: 8, output_tokens: 2 } },
    )
    const tool = (await persistedDimensions()).tool.buckets[String(bucketTs)]
    expect(tool.Read.requestCount).toBe(1)
    expect(tool.Bash.requestCount).toBe(1)
    // Each tool key gets the full request's tokens (multi-key dimensions overlap — documented caveat).
    expect(tool.Read.inputTokens).toBe(8)
  })

  test("null key skips the dimension; empty multi-key array records nothing", async () => {
    const now = Date.now()
    recordSettledRequest(
      { model: "m", client: null, tool: [] },
      { startedAt: now, endedAt: now + 10, success: true, usage: { input_tokens: 1, output_tokens: 1 } },
    )
    const dims = await persistedDimensions()
    expect(dims.model).toBeDefined()
    expect(dims.client).toBeUndefined()
    expect(dims.tool).toBeUndefined()
  })

  test("per-token-type cost accumulates tokens × multiplier; omitted when multiplier is undefined", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    // multiplier = 3 (e.g. opus): cost_x = tokens_x × 3
    recordSettledRequest(
      { model: "opus" },
      {
        startedAt: now,
        endedAt: now + 10,
        success: true,
        multiplier: 3,
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    )
    // No multiplier (token-based account): cost stays 0.
    recordSettledRequest({ model: "free" }, { startedAt: now, endedAt: now + 10, success: true, usage: { input_tokens: 50, output_tokens: 10 } })

    const model = (await persistedDimensions()).model.buckets[String(bucketTs)]
    expect(model.opus.costInputTokens).toBe(300)
    expect(model.opus.costOutputTokens).toBe(120)
    expect(model.opus.costCacheReadInputTokens).toBe(60)
    expect(model.opus.costCacheCreationInputTokens).toBe(15)
    expect(model.opus.costReasoningTokens).toBe(36)
    expect(model.free.costInputTokens).toBe(0)
    expect(model.free.costOutputTokens).toBe(0)
  })

  test("thinking-block measures accumulate per request across dimensions; omitted (0) when thinkingBlocks is undefined", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    recordSettledRequest(
      { model: "opus" },
      { startedAt: now, endedAt: now + 10, success: true, thinkingBlocks: { nonEmpty: 2, emptySigned: 1, emptyUnsigned: 3 } },
    )
    recordSettledRequest(
      { model: "opus" },
      { startedAt: now, endedAt: now + 10, success: true, thinkingBlocks: { nonEmpty: 1, emptySigned: 0, emptyUnsigned: 1 } },
    )
    // No thinkingBlocks → the three measures stay 0 for this key.
    recordSettledRequest({ model: "sonnet" }, { startedAt: now, endedAt: now + 10, success: true })

    const model = (await persistedDimensions()).model.buckets[String(bucketTs)]
    expect(model.opus.thinkingBlocksNonEmpty).toBe(3)
    expect(model.opus.thinkingBlocksEmptySigned).toBe(1)
    expect(model.opus.thinkingBlocksEmptyUnsigned).toBe(4)
    expect(model.sonnet.thinkingBlocksNonEmpty).toBe(0)
    expect(model.sonnet.thinkingBlocksEmptySigned).toBe(0)
    expect(model.sonnet.thinkingBlocksEmptyUnsigned).toBe(0)
  })

  test("getThinkingBlockTotals sums the three feature measures across the agentKind dimension (main + subagent = global)", () => {
    const now = Date.now()
    // main request: 2 nonEmpty, 1 emptySigned, 0 emptyUnsigned
    recordSettledRequest(
      { agentKind: "main", model: "opus" },
      { startedAt: now, endedAt: now + 1, success: true, thinkingBlocks: { nonEmpty: 2, emptySigned: 1, emptyUnsigned: 0 } },
    )
    // subagent request: 1 nonEmpty, 0 emptySigned, 3 emptyUnsigned
    recordSettledRequest(
      { agentKind: "subagent", model: "opus" },
      { startedAt: now, endedAt: now + 1, success: true, thinkingBlocks: { nonEmpty: 1, emptySigned: 0, emptyUnsigned: 3 } },
    )
    // a request with no thinking blocks contributes nothing
    recordSettledRequest({ agentKind: "main", model: "sonnet" }, { startedAt: now, endedAt: now + 1, success: true })

    // Σ over agentKind keys (main + subagent) === exact global per-block total.
    expect(getThinkingBlockTotals()).toEqual({ nonEmpty: 3, emptySigned: 1, emptyUnsigned: 3 })
  })

  test("getThinkingBlockTotals returns zeros before any request settles", () => {
    expect(getThinkingBlockTotals()).toEqual({ nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 })
  })

  test("capped dimension bounds its key count and merges overflow into 'other'", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    // 250 distinct client keys; cap is 200 → 200 real keys + 1 "other".
    for (let i = 0; i < 250; i++) {
      recordSettledRequest(
        { client: `client-${i}` },
        { startedAt: now, endedAt: now + 1, success: true, usage: { input_tokens: 1, output_tokens: 0 } },
        new Set(["client"]),
      )
    }
    const client = (await persistedDimensions()).client.buckets[String(bucketTs)]
    const keyCount = Object.keys(client).length
    expect(keyCount).toBe(201) // 200 + "other"
    expect(client.other.requestCount).toBe(50) // the 50 overflow keys
    // An UNcapped dimension is never collapsed (no cappedDimensions set passed).
  })

  test("uncapped dimension keeps every distinct key (no 'other' collapse)", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    for (let i = 0; i < 250; i++) {
      recordSettledRequest({ endpoint: `ep-${i}` }, { startedAt: now, endedAt: now + 1, success: true })
    }
    const endpoint = (await persistedDimensions()).endpoint.buckets[String(bucketTs)]
    expect(Object.keys(endpoint).length).toBe(250)
    expect(endpoint.other).toBeUndefined()
  })

  test("cardinality cap stays bounded ACROSS a restart that writes into a loaded bucket", async () => {
    // Regression for the per-store cap fix: pre-fix, the cap consulted only the
    // (post-load empty) dimSinceStart, so post-restart traffic into the same 5-min
    // bucket blew past the cap (probe: 401). Each store must bound its OWN bucket.
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    for (let i = 0; i < 250; i++) {
      recordSettledRequest({ client: `c-${i}` }, { startedAt: now, endedAt: now + 1, success: true }, new Set(["client"]))
    }
    await persistRequestTelemetry()

    // Simulate a restart: reset process state, reload the persisted file.
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()

    // Fresh traffic into the SAME bucket the loaded keys live in.
    for (let i = 0; i < 250; i++) {
      recordSettledRequest({ client: `d-${i}` }, { startedAt: now, endedAt: now + 1, success: true }, new Set(["client"]))
    }
    // The bucket must still be bounded at CAP + "other" — not 401.
    const client = (await persistedDimensions()).client.buckets[String(bucketTs)]
    expect(Object.keys(client).length).toBe(201)
    expect(client.other).toBeDefined()
  })
})

describe("getDimensionBreakdown", () => {
  test("sinceStart window projects cumulative counters with no series; sorts by request count", () => {
    const now = Date.now()
    recordSettledRequest({ tool: ["Read", "Read", "Bash"] }, { startedAt: now, endedAt: now + 1, success: true })
    recordSettledRequest({ tool: ["Read"] }, { startedAt: now, endedAt: now + 1, success: true })

    const breakdown = getDimensionBreakdown("tool", "sinceStart", 20, now)
    expect(breakdown.window).toBe("sinceStart")
    expect(breakdown.totalKeys).toBe(2)
    expect(breakdown.keys[0].key).toBe("Read") // 2 requests
    expect(breakdown.keys[0].counters.requestCount).toBe(2)
    expect(breakdown.keys[0].series).toEqual([]) // no series for sinceStart
    expect(breakdown.keys[1].key).toBe("Bash")
  })

  test("7d top-N folds the tail into 'other', merging with a cap-induced 'other'", () => {
    const now = Date.now()
    // 250 distinct capped client keys → 200 real + cap "other". The cap "other"
    // is high-frequency (50 requests) so it lands in top-N; the top-N tail merge
    // must fold into it (not duplicate the key).
    for (let i = 0; i < 250; i++) {
      recordSettledRequest({ client: `c-${i}` }, { startedAt: now, endedAt: now + 1, success: true }, new Set(["client"]))
    }
    const breakdown = getDimensionBreakdown("client", "7d", 5, now)
    expect(breakdown.totalKeys).toBe(201) // 200 + cap "other"
    expect(breakdown.truncated).toBe(true)
    const otherEntries = breakdown.keys.filter((k) => k.key === "other")
    expect(otherEntries).toHaveLength(1) // exactly one "other", not duplicated
    // The single "other" absorbed the 50 cap-overflow requests + the folded tail.
    expect(otherEntries[0].counters.requestCount).toBeGreaterThanOrEqual(50)
  })

  test("unknown dimension yields an empty breakdown", () => {
    const breakdown = getDimensionBreakdown("does-not-exist", "7d")
    expect(breakdown.totalKeys).toBe(0)
    expect(breakdown.keys).toEqual([])
    expect(breakdown.truncated).toBe(false)
  })
})

describe("distribution histograms", () => {
  test("computes interpolated latency percentiles from the duration_ms histogram", () => {
    const now = Date.now()
    // 5 requests at 10ms, 5 at 100ms → duration_ms buckets [.,5@le10,.,.,5@le100,...].
    for (let i = 0; i < 5; i++) recordSettledRequest({ model: "m" }, { startedAt: now, endedAt: now + 10, success: true })
    for (let i = 0; i < 5; i++) recordSettledRequest({ model: "m" }, { startedAt: now, endedAt: now + 100, success: true })

    const hist = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms.duration_ms
    expect(hist.count).toBe(10)
    expect(hist.sum).toBe(550) // 5*10 + 5*100
    expect(hist.average).toBe(55)
    // p50 lands at the top of the 10ms bucket; p90 interpolates into the 100ms bucket.
    expect(hist.p50).toBe(10)
    expect(hist.p90).toBeCloseTo(90, 5)
    expect(hist.p99).toBeCloseTo(99, 5)
    expect(hist.buckets.reduce((a, b) => a + b, 0)).toBe(10) // Σbuckets == count
  })

  test("input/output token + queue-wait histograms observe their respective quantities", () => {
    const now = Date.now()
    recordSettledRequest(
      { model: "m" },
      { startedAt: now, endedAt: now + 5, success: true, queueWaitMs: 250, usage: { input_tokens: 4000, output_tokens: 80 } },
    )
    const hist = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms
    expect(hist.input_tokens.count).toBe(1)
    expect(hist.input_tokens.sum).toBe(4000)
    expect(hist.output_tokens.sum).toBe(80)
    expect(hist.queue_wait_ms.sum).toBe(250)
    expect(hist.queue_wait_ms.p50).toBeGreaterThan(100) // 250 lands in the (100,250] bucket
  })

  test("7d histogram stub (T7.2): sinceStart histograms are FULL (feed /metrics); 7d histograms are empty {}", () => {
    const now = Date.now()
    // Record with observable latency + token + queue-wait so sinceStart histograms populate.
    for (let i = 0; i < 5; i++) {
      recordSettledRequest(
        { model: "m" },
        { startedAt: now, endedAt: now + 50, success: true, queueWaitMs: 120, usage: { input_tokens: 3000, output_tokens: 60 } },
      )
    }

    // sinceStart leg (feeds /metrics Prometheus histogram) — histograms MUST stay full (not regressed).
    const sinceStart = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms
    expect(sinceStart.duration_ms.count).toBe(5)
    expect(sinceStart.duration_ms.sum).toBe(250)
    expect(sinceStart.input_tokens.count).toBe(5)
    expect(sinceStart.queue_wait_ms.sum).toBe(600)

    // 7d leg (old ui/ only, ui-v4 unused) — histograms are RETIRED → empty stub. counters/series stay full.
    const sevenDay = getDimensionBreakdown("model", "7d", 20, now).keys[0]
    expect(sevenDay.counters.requestCount).toBe(5) // counters intact
    expect(sevenDay.histograms).toEqual({}) // empty stub — no latency/token/queue-wait percentiles
  })

  test("7d histogram stub survives a rebuild: after restart the 7d histograms stay {} while counters rebuild exactly", async () => {
    const now = Date.now()
    await initRequestTelemetry()
    for (let i = 0; i < 3; i++) recordSettledRequest({ model: "m" }, { startedAt: now, endedAt: now + 50, success: true })
    await persistRequestTelemetry()

    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()

    const key = getDimensionBreakdown("model", "7d", 20, now).keys[0]
    expect(key.counters.requestCount).toBe(3) // counters rebuilt from tel_raw
    expect(key.histograms).toEqual({}) // 7d histograms retired — empty stub after rebuild too
  })

  test("clamps a negative observation (clock-skewed queueWaitMs) into bucket 0 without polluting the sum (M2)", () => {
    const now = Date.now()
    recordSettledRequest({ model: "m" }, { startedAt: now, endedAt: now + 5, success: true, queueWaitMs: -250 })
    const hist = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms.queue_wait_ms
    expect(hist.count).toBe(1)
    expect(hist.sum).toBe(0) // -250 clamped to 0, not subtracted
  })

  test("timing distributions registered + observe their ms values (spec 2026-07-14 §6.1)", () => {
    // Registration: the 3 timing histograms are in the shared registry → also exposed on /metrics.
    const names = TELEMETRY_HISTOGRAMS.map((h) => h.name)
    expect(names).toContain("upstream_first_token_ms")
    expect(names).toContain("client_first_real_ms")
    expect(names).toContain("buffer_hold_ms")

    const now = Date.now()
    recordSettledRequest(
      { model: "m" },
      { startedAt: now, endedAt: now + 80_000, success: true, upstreamFirstTokenMs: 6000, clientFirstRealMs: 79_000, bufferHoldMs: 78_980 },
    )
    const hist = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms
    expect(hist.upstream_first_token_ms.count).toBe(1)
    expect(hist.upstream_first_token_ms.sum).toBe(6000)
    expect(hist.client_first_real_ms.sum).toBe(79_000)
    expect(hist.buffer_hold_ms.sum).toBe(78_980)
    // 400_000 top boundary covers the observed max (~356s) — 79s lands well inside, not +Inf.
    expect(hist.client_first_real_ms.p50).toBeLessThan(400_000)
  })

  test("absent timing → distribution not observed (omitted from breakdown)", () => {
    const now = Date.now()
    recordSettledRequest({ model: "m" }, { startedAt: now, endedAt: now + 5, success: true })
    const hist = getDimensionBreakdown("model", "sinceStart", 20, now).keys[0].histograms
    // Unobserved distributions are omitted from the breakdown (only duration_ms is always present).
    expect(hist.upstream_first_token_ms).toBeUndefined()
  })
})
