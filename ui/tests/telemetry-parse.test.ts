import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { parseRequestTelemetry } from "@/composables/telemetry-parse"

describe("parseRequestTelemetry", () => {
  test("returns null when raw is null/undefined/non-object", () => {
    expect(parseRequestTelemetry(null)).toBeNull()
    expect(parseRequestTelemetry(undefined)).toBeNull()
    expect(parseRequestTelemetry(42)).toBeNull()
  })

  test("parses a full snapshot with model stats + usage, defaulting missing numbers to 0", () => {
    const raw = {
      acceptedSinceStart: 10,
      bucketSizeMinutes: 5,
      windowDays: 7,
      totalLast7d: 100,
      buckets: [{ timestamp: 1, count: 3 }, { timestamp: 2 /* count missing */ }],
      modelsSinceStart: [
        {
          model: "claude-opus-4.8",
          requestCount: 5,
          successCount: 4,
          failureCount: 1,
          totalDurationMs: 5000,
          averageDurationMs: 1000,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, reasoningTokens: 20 },
        },
      ],
      modelsLast7d: [{ model: "claude-opus-4.8", requestCount: 5, usage: {}, buckets: [{ timestamp: 1, requestCount: 2, usage: {} }] }],
    }
    const snap = parseRequestTelemetry(raw)
    expect(snap).not.toBeNull()
    expect(snap!.acceptedSinceStart).toBe(10)
    expect(snap!.buckets).toEqual([
      { timestamp: 1, count: 3 },
      { timestamp: 2, count: 0 },
    ])
    expect(snap!.modelsSinceStart[0].usage.reasoningTokens).toBe(20)
    // missing numeric fields default to 0
    expect(snap!.modelsLast7d[0].successCount).toBe(0)
    expect(snap!.modelsLast7d[0].usage.totalTokens).toBe(0)
    expect(snap!.modelsLast7d[0].buckets[0].requestCount).toBe(2)
  })

  test("non-array models/buckets degrade to empty arrays", () => {
    const snap = parseRequestTelemetry({ modelsSinceStart: "nope", modelsLast7d: null, buckets: 5 })
    expect(snap!.modelsSinceStart).toEqual([])
    expect(snap!.modelsLast7d).toEqual([])
    expect(snap!.buckets).toEqual([])
  })

  test("defaults bucketSizeMinutes to 5 and windowDays to 7 when missing", () => {
    const snap = parseRequestTelemetry({})
    expect(snap!.bucketSizeMinutes).toBe(5)
    expect(snap!.windowDays).toBe(7)
    expect(snap!.acceptedSinceStart).toBe(0)
  })
})
