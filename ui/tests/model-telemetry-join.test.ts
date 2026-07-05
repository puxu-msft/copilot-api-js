import type { Model } from "~backend/lib/models/client"
import type { RequestTelemetryModelStats, RequestTelemetrySnapshot } from "@/composables/telemetry-parse"

import { describe, expect, test } from "bun:test"

import { buildModelTelemetryIndex } from "@/composables/model-telemetry-join"

const usage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 })

function stats(model: string, over: Partial<RequestTelemetryModelStats> = {}): RequestTelemetryModelStats {
  return { model, requestCount: 0, successCount: 0, failureCount: 0, totalDurationMs: 0, averageDurationMs: 0, usage: usage(), ...over }
}

function model(id: string): Model {
  return { id, name: id, vendor: "Anthropic", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1" } as Model
}

function snap(last7d: Array<RequestTelemetryModelStats>, sinceStart: Array<RequestTelemetryModelStats> = []): RequestTelemetrySnapshot {
  return { acceptedSinceStart: 0, bucketSizeMinutes: 5, windowDays: 7, totalLast7d: 0, buckets: [], modelsSinceStart: sinceStart, modelsLast7d: last7d.map((s) => ({ ...s, buckets: [] })) }
}

describe("buildModelTelemetryIndex", () => {
  test("returns empty index for null snapshot", () => {
    const idx = buildModelTelemetryIndex(null, [model("claude-opus-4.8")])
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toEqual([])
  })

  test("joins canonical telemetry key to matching model.id", () => {
    const idx = buildModelTelemetryIndex(snap([stats("claude-opus-4.8", { requestCount: 5 })]), [model("claude-opus-4.8")])
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.requestCount).toBe(5)
    expect(idx.unmatched).toEqual([])
  })

  test("aggregates success (canonical) + failure (dashed) legs that normalize to the same id", () => {
    // Upstream canonical "claude-opus-4-8" normalizes to "claude-opus-4.8"; both legs merge onto the one catalog id.
    const idx = buildModelTelemetryIndex(
      snap([stats("claude-opus-4-8", { requestCount: 4, successCount: 4 }), stats("claude-opus-4.8", { requestCount: 2, failureCount: 2 })]),
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(6)
    expect(joined?.last7d?.successCount).toBe(4)
    expect(joined?.last7d?.failureCount).toBe(2)
    expect(idx.unmatched).toEqual([])
  })

  test("merges a date-suffixed failure-leg alias onto the canonical model id (spec §4.2 core)", () => {
    // Failure legs key on the verbatim client alias, which is often the dated form
    // `claude-opus-4-8-20250514`. normalizeModelId strips the date + dashes → `claude-opus-4.8`,
    // so it must merge with the canonical success leg rather than scatter to unmatched.
    const idx = buildModelTelemetryIndex(
      snap([stats("claude-opus-4.8", { requestCount: 4, successCount: 4 }), stats("claude-opus-4-8-20250514", { requestCount: 5, failureCount: 5 })]),
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(9)
    expect(joined?.last7d?.failureCount).toBe(5)
    expect(idx.unmatched).toEqual([])
  })

  test("recomputes averageDurationMs after aggregation", () => {
    const idx = buildModelTelemetryIndex(
      snap([stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 2000 }), stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 6000 })]),
      [model("claude-opus-4.8")],
    )
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.averageDurationMs).toBe(2000)
  })

  test("telemetry with no matching model.id goes to unmatched (never dropped)", () => {
    const idx = buildModelTelemetryIndex(snap([stats("opus", { requestCount: 3, failureCount: 3 })]), [model("claude-opus-4.8")])
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toHaveLength(1)
    expect(idx.unmatched[0].model).toBe("opus")
    expect(idx.unmatched[0].last7d?.failureCount).toBe(3)
  })

  test("joins sinceStart + last7d windows independently onto the same model", () => {
    const idx = buildModelTelemetryIndex(
      snap([stats("claude-opus-4.8", { requestCount: 7 })], [stats("claude-opus-4.8", { requestCount: 99 })]),
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(7)
    expect(joined?.sinceStart?.requestCount).toBe(99)
  })

  test("aggregates usage token dimensions across merged legs", () => {
    const idx = buildModelTelemetryIndex(
      snap([
        stats("claude-opus-4.8", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 1, cacheCreationInputTokens: 2, reasoningTokens: 3 } }),
        stats("claude-opus-4.8", { usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, reasoningTokens: 7 } }),
      ]),
      [model("claude-opus-4.8")],
    )
    const u = idx.byId.get("claude-opus-4.8")?.last7d?.usage
    expect(u?.inputTokens).toBe(30)
    expect(u?.totalTokens).toBe(40)
    expect(u?.reasoningTokens).toBe(10)
  })
})
