import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { modelsToCsv } from "@/lib/models-csv"

const m = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "claude-opus-4.8",
    name: "Opus",
    vendor: "Anthropic",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
    billing: { multiplier: 3, is_premium: true, restricted_to: ["pro", "business"] },
    capabilities: { type: "chat", family: "claude-opus-4", supports: { vision: true }, limits: { max_context_window_tokens: 1_000_000 } },
    ...over,
  }) as Model

const telem = (requestCount: number, failureCount: number): JoinedModelTelemetry => ({
  last7d: {
    model: "x",
    requestCount,
    successCount: requestCount - failureCount,
    failureCount,
    totalDurationMs: 0,
    averageDurationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
  },
  sinceStart: null,
})

describe("modelsToCsv", () => {
  it("header + one row with telemetry + joined restricted_to", () => {
    const csv = modelsToCsv([m()], (id) => (id === "claude-opus-4.8" ? telem(5, 1) : null))
    const [header, row] = csv.split("\n")
    expect(header).toContain("id,vendor")
    expect(header).toContain("requests_7d")
    expect(header).toContain("failures_7d")
    expect(row).toContain("claude-opus-4.8")
    expect(row).toContain("pro;business")
    const cells = row.split(",")
    expect(cells).toContain("5")
    expect(cells).toContain("1")
  })

  it("escapes commas and quotes (RFC-4180)", () => {
    expect(modelsToCsv([m({ capabilities: { family: "x,y", supports: {}, limits: {} } })], () => null).split("\n")[1]).toContain('"x,y"')
    expect(modelsToCsv([m({ capabilities: { family: 'a"b', supports: {}, limits: {} } })], () => null).split("\n")[1]).toContain('"a""b"')
  })

  it("missing telemetry → empty trailing cells", () => {
    const cells = modelsToCsv([m()], () => null)
      .split("\n")[1]
      .split(",")
    expect(cells.at(-1)).toBe("")
    expect(cells.at(-2)).toBe("")
  })
})
