import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { modelsToCsv } from "@/utils/models-csv"

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
    capabilities: { type: "chat", family: "claude-opus-4", supports: { vision: true }, limits: { max_context_window_tokens: 1000000 } },
    ...over,
  }) as Model

const telemetry = (requestCount: number, failureCount: number) => ({
  last7d: { model: "x", requestCount, successCount: requestCount - failureCount, failureCount, totalDurationMs: 0, averageDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 } },
  sinceStart: null,
})

describe("modelsToCsv", () => {
  test("header + one row with telemetry", () => {
    const csv = modelsToCsv([m()], deriveCapabilities, (id) => (id === "claude-opus-4.8" ? telemetry(5, 1) : null))
    const [header, row] = csv.split("\n")
    expect(header).toContain("id,vendor")
    expect(header).toContain("requests_7d")
    expect(header).toContain("failures_7d")
    expect(row).toContain("claude-opus-4.8")
    expect(row).toContain("pro;business") // restricted_to joined with ;
    expect(row.split(",")).toContain("5") // requests_7d
    expect(row.split(",")).toContain("1") // failures_7d
  })

  test("escapes fields containing commas", () => {
    const csv = modelsToCsv([m({ capabilities: { family: "x,y", supports: {}, limits: {} } })], deriveCapabilities, () => null)
    expect(csv.split("\n")[1]).toContain('"x,y"')
  })

  test("escapes fields containing quotes by doubling them", () => {
    const csv = modelsToCsv([m({ capabilities: { family: 'a"b', supports: {}, limits: {} } })], deriveCapabilities, () => null)
    expect(csv.split("\n")[1]).toContain('"a""b"')
  })

  test("missing telemetry → empty telemetry cells", () => {
    const csv = modelsToCsv([m()], deriveCapabilities, () => null)
    const cells = csv.split("\n")[1].split(",")
    // last two columns (requests_7d, failures_7d) are empty
    expect(cells[cells.length - 1]).toBe("")
    expect(cells[cells.length - 2]).toBe("")
  })
})
