import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
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
    recordSettledRequest("claude-sonnet-4.6", {
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
    })
    recordSettledRequest("claude-sonnet-4.6", {
      startedAt: now + 301_000,
      endedAt: now + 302_000,
      success: false,
      usage: {
        input_tokens: 20,
        output_tokens: 0,
      },
    })

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
    recordSettledRequest("gpt-5.2", {
      startedAt: now,
      endedAt: now + 500,
      success: true,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    })
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
      recordSettledRequest(`model-${i % 3}`, {
        startedAt: now - i,
        endedAt: now,
        success: true,
        usage: { input_tokens: i, output_tokens: i * 2 },
      })
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
})
