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
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  getDimensionBreakdown,
  getRequestTelemetrySnapshot,
  initRequestTelemetry,
  persistRequestTelemetry,
  recordAcceptedRequest,
  recordSettledRequest,
} from "~/lib/request-telemetry"

let tempDir: string
let telemetryFile: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "request-telemetry-test-"))
  telemetryFile = path.join(tempDir, "request-telemetry.json")
  _resetRequestTelemetryForTests()
  _setRequestTelemetryFilePathForTests(telemetryFile)
})

afterEach(async () => {
  _resetRequestTelemetryForTests()
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

  test("concurrent persists serialize and produce a readable file (no torn writes)", async () => {
    const now = Date.now()
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

    // Fire many persists in parallel — the periodic timer and shutdown can
    // race in production. With the serialized atomic-write path, the final
    // file must be parseable JSON, not torn bytes.
    await Promise.all(Array.from({ length: 25 }, () => persistRequestTelemetry()))

    const raw = await fs.readFile(telemetryFile, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()

    // No stray temp files should be left behind.
    const siblings = await fs.readdir(tempDir)
    expect(siblings.filter((name) => name.includes(".tmp."))).toEqual([])

    // Re-init from the persisted file → state survives.
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(telemetryFile)
    await initRequestTelemetry()
    const snapshot = getRequestTelemetrySnapshot(now)
    expect(snapshot.modelsLast7d.length).toBeGreaterThan(0)
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

  test("migrates a legacy V2 file (modelBuckets → model dimension); since-start stays empty", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    const v2 = {
      version: 2,
      buckets: { [String(bucketTs)]: 3 },
      modelBuckets: {
        [String(bucketTs)]: {
          "claude-opus-4.8": {
            requestCount: 2,
            successCount: 2,
            failureCount: 0,
            totalDurationMs: 4_000,
            inputTokens: 200,
            outputTokens: 80,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            reasoningTokens: 30,
          },
        },
      },
    }
    await fs.writeFile(telemetryFile, JSON.stringify(v2), "utf8")
    await initRequestTelemetry()

    const snapshot = getRequestTelemetrySnapshot(now)
    expect(snapshot.modelsSinceStart).toEqual([]) // C2: since-start is process-ephemeral, never seeded from buckets on load
    expect(snapshot.modelsLast7d).toHaveLength(1)
    expect(snapshot.modelsLast7d[0]).toMatchObject({
      model: "claude-opus-4.8",
      requestCount: 2,
      successCount: 2,
      failureCount: 0,
      totalDurationMs: 4_000,
      averageDurationMs: 2_000,
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, reasoningTokens: 30 },
    })
  })

  test("round-trips an unknown future dimension without loss (forward-compat)", async () => {
    const now = Date.now()
    const bucketTs = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000)
    const acc = {
      requestCount: 1,
      successCount: 1,
      failureCount: 0,
      totalDurationMs: 100,
      inputTokens: 5,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    }
    // A V3 file carrying an "endpoint" dimension this build registers no extractor for.
    const v3 = {
      version: 3,
      buckets: { [String(bucketTs)]: 1 },
      dimensions: {
        model: { buckets: { [String(bucketTs)]: { m1: acc } } },
        endpoint: { buckets: { [String(bucketTs)]: { "anthropic-messages": acc } } },
      },
    }
    await fs.writeFile(telemetryFile, JSON.stringify(v3), "utf8")
    await initRequestTelemetry()

    // The known model dimension still projects; the unknown endpoint dim loaded into storage.
    expect(getRequestTelemetrySnapshot(now).modelsLast7d).toHaveLength(1)

    // Persist round-trips the unknown dimension (no allow-list drop).
    await persistRequestTelemetry()
    const reloaded = JSON.parse(await fs.readFile(telemetryFile, "utf8")) as {
      version: number
      dimensions: Record<string, { buckets: Record<string, Record<string, { requestCount: number }>> }>
    }
    expect(reloaded.version).toBe(3)
    expect(reloaded.dimensions.endpoint.buckets[String(bucketTs)]["anthropic-messages"].requestCount).toBe(1)
  })
})

/**
 * Persist + re-read the file to inspect raw per-dimension counters (the snapshot
 * surface only projects `model` until commit 8's `getDimensionBreakdown`). This
 * exercises the real generic persistence path, so it doubles as a serializer test.
 */
async function persistedDimensions(): Promise<Record<string, { buckets: Record<string, Record<string, Record<string, number>>> }>> {
  await persistRequestTelemetry()
  const parsed = JSON.parse(await fs.readFile(telemetryFile, "utf8")) as {
    dimensions: Record<string, { buckets: Record<string, Record<string, Record<string, number>>> }>
  }
  return parsed.dimensions
}

describe("dimension/measure framework", () => {
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
