import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { EntrySummary } from "@/types"

import {
  //
  endpointLabel,
  failureSummary,
  modelName,
  requestState,
  rowAnomaly,
  statusColor,
  statusLabel,
  tokenCacheRead,
  truncPreview,
} from "@/utils/activity-helpers"

function entry(over: Partial<EntrySummary> = {}): EntrySummary {
  return { id: "e", startedAt: 0, endpoint: "anthropic-messages", messageCount: 0, previewText: "", searchText: "", ...over }
}

describe("requestState", () => {
  test("prefers explicit state, else infers from responseSuccess", () => {
    expect(requestState(entry({ state: "aborted" }))).toBe("aborted")
    expect(requestState(entry({ responseSuccess: false }))).toBe("failed")
    expect(requestState(entry({ responseSuccess: true }))).toBe("completed")
    expect(requestState(entry())).toBe("pending")
  })
})

describe("status presentation (derives from STATUS_META)", () => {
  test("aborted / interrupted get their own color + label (not pending)", () => {
    expect(statusColor(entry({ state: "aborted" }))).toBe("aborted")
    expect(statusColor(entry({ state: "interrupted" }))).toBe("interrupted")
    expect(statusLabel(entry({ state: "aborted" }))).toBe("Aborted")
    expect(statusColor(entry({ state: "completed" }))).toBe("success")
  })
})

describe("failureSummary (list-layer attribution)", () => {
  test("completed → empty (caller shows preview instead)", () => {
    expect(failureSummary(entry({ state: "completed" }))).toBe("")
  })
  test("failed → state + strategy + retry count + error", () => {
    const s = failureSummary(entry({ state: "failed", currentStrategy: "auto-truncate", attemptCount: 3, responseError: "413 too large" }))
    expect(s).toContain("failed")
    expect(s).toContain("auto-truncate")
    expect(s).toContain("×3")
    expect(s).toContain("413 too large")
  })
  test("interrupted includes pid", () => {
    expect(failureSummary(entry({ state: "interrupted", pid: 1234 }))).toContain("pid 1234")
  })
  test("long error is truncated", () => {
    const s = failureSummary(entry({ state: "failed", responseError: "x".repeat(200) }))
    expect(s.length).toBeLessThan(120)
  })
})

describe("rowAnomaly heuristics", () => {
  test("slow when duration > 60s", () => {
    expect(rowAnomaly(entry({ durationMs: 61_000 })).slow).toBe(true)
    expect(rowAnomaly(entry({ durationMs: 5_000 })).slow).toBe(false)
  })
  test("cacheMiss only for completed large-input requests with no cache read", () => {
    expect(rowAnomaly(entry({ state: "completed", usage: { input_tokens: 30_000, output_tokens: 1 } })).cacheMiss).toBe(true)
    // small input → not flagged
    expect(rowAnomaly(entry({ state: "completed", usage: { input_tokens: 100, output_tokens: 1 } })).cacheMiss).toBe(false)
    // cache hit → not flagged
    expect(rowAnomaly(entry({ state: "completed", usage: { input_tokens: 30_000, output_tokens: 1, cache_read_input_tokens: 9000 } })).cacheMiss).toBe(false)
    // non-completed → not flagged
    expect(rowAnomaly(entry({ state: "streaming", usage: { input_tokens: 30_000, output_tokens: 1 } })).cacheMiss).toBe(false)
  })
})

describe("misc helpers", () => {
  test("tokenCacheRead formats or dashes", () => {
    expect(tokenCacheRead(entry({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2048 } }))).toContain("K")
    expect(tokenCacheRead(entry())).toBe("-")
  })
  test("modelName prefers response model, falls back to request model", () => {
    expect(modelName(entry({ responseModel: "opus", requestModel: "sonnet" }))).toBe("opus")
    expect(modelName(entry({ requestModel: "sonnet" }))).toBe("sonnet")
    expect(modelName(entry())).toBe("-")
  })
  test("endpointLabel prefers rawPath", () => {
    expect(endpointLabel(entry({ rawPath: "/v1/messages" }))).toBe("/v1/messages")
  })
  test("truncPreview caps at 120 chars", () => {
    expect(truncPreview(entry({ previewText: "y".repeat(200) })).length).toBeLessThanOrEqual(120)
  })
})
