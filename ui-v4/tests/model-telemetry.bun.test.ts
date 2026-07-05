import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  buildModelTelemetryIndex,
  parseRequestTelemetry,
  type ModelTelemetryStats,
} from "@/lib/model-telemetry"

const usage = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 })
const stats = (model: string, over: Partial<ModelTelemetryStats> = {}): ModelTelemetryStats => ({
  model,
  requestCount: 0,
  successCount: 0,
  failureCount: 0,
  totalDurationMs: 0,
  averageDurationMs: 0,
  usage: usage(),
  ...over,
})
const model = (id: string): Model =>
  ({
    id,
    name: id,
    vendor: "Anthropic",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
  }) as Model

describe("parseRequestTelemetry", () => {
  it("returns null for non-object", () => {
    expect(parseRequestTelemetry(null)).toBeNull()
    expect(parseRequestTelemetry(42)).toBeNull()
  })

  it("parses model stats defaulting missing numbers to 0", () => {
    const snap = parseRequestTelemetry({
      modelsSinceStart: [{ model: "claude-opus-4.8", requestCount: 5, usage: { inputTokens: 10 } }],
      modelsLast7d: [{ model: "claude-opus-4.8", requestCount: 3 }],
    })
    expect(snap).not.toBeNull()
    expect(snap!.modelsSinceStart[0].requestCount).toBe(5)
    expect(snap!.modelsSinceStart[0].usage.inputTokens).toBe(10)
    expect(snap!.modelsSinceStart[0].successCount).toBe(0)
    expect(snap!.modelsLast7d[0].usage.totalTokens).toBe(0)
  })

  it("degrades non-array models to []", () => {
    const snap = parseRequestTelemetry({ modelsSinceStart: "nope" })
    expect(snap!.modelsSinceStart).toEqual([])
  })
})

describe("buildModelTelemetryIndex", () => {
  it("empty index for null snapshot", () => {
    const idx = buildModelTelemetryIndex(null, [model("claude-opus-4.8")])
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toEqual([])
  })

  it("joins canonical telemetry key to model.id", () => {
    const idx = buildModelTelemetryIndex({ modelsSinceStart: [], modelsLast7d: [stats("claude-opus-4.8", { requestCount: 5 })] }, [model("claude-opus-4.8")])
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.requestCount).toBe(5)
  })

  it("merges success (canonical) + failure (dashed/dated alias) legs onto same id", () => {
    const idx = buildModelTelemetryIndex(
      {
        modelsSinceStart: [],
        modelsLast7d: [stats("claude-opus-4-8", { requestCount: 4, successCount: 4 }), stats("claude-opus-4-8-20250514", { requestCount: 5, failureCount: 5 })],
      },
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(9)
    expect(joined?.last7d?.failureCount).toBe(5)
    expect(idx.unmatched).toEqual([])
  })

  it("recomputes averageDurationMs after merge", () => {
    const idx = buildModelTelemetryIndex(
      {
        modelsSinceStart: [],
        modelsLast7d: [
          stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 2000 }),
          stats("claude-opus-4.8", { requestCount: 2, totalDurationMs: 6000 }),
        ],
      },
      [model("claude-opus-4.8")],
    )
    expect(idx.byId.get("claude-opus-4.8")?.last7d?.averageDurationMs).toBe(2000)
  })

  it("surfaces un-joinable telemetry in unmatched (never dropped)", () => {
    const idx = buildModelTelemetryIndex({ modelsSinceStart: [], modelsLast7d: [stats("opus", { requestCount: 3, failureCount: 3 })] }, [
      model("claude-opus-4.8"),
    ])
    expect(idx.byId.size).toBe(0)
    expect(idx.unmatched).toHaveLength(1)
    expect(idx.unmatched[0].model).toBe("opus")
    expect(idx.unmatched[0].last7d?.failureCount).toBe(3)
  })

  it("joins sinceStart + last7d windows independently", () => {
    const idx = buildModelTelemetryIndex(
      { modelsSinceStart: [stats("claude-opus-4.8", { requestCount: 99 })], modelsLast7d: [stats("claude-opus-4.8", { requestCount: 7 })] },
      [model("claude-opus-4.8")],
    )
    const joined = idx.byId.get("claude-opus-4.8")
    expect(joined?.last7d?.requestCount).toBe(7)
    expect(joined?.sinceStart?.requestCount).toBe(99)
  })
})
