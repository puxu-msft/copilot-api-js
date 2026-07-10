/**
 * Pure-logic tests for the request-row domain helpers (ported from the old UI's
 * activity-helpers). Asserts real derived strings/flags — state fallbacks,
 * endpoint cleaning, token formatting, preview truncation, failure attribution,
 * and anomaly thresholds — not trivial mocks.
 */

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
  isTerminalSummary,
  modelName,
  requestState,
  rowAnomaly,
  tokenCacheRead,
  tokenIn,
  tokenOut,
  truncPreview,
} from "@/lib/activity-row"

// ── helpers ──

const base = (over: Partial<EntrySummary>): EntrySummary => ({
  id: "x",
  startedAt: 0,
  endpoint: "anthropic-messages",
  messageCount: 0,
  previewText: "",
  responsePreviewText: "",
  ...over,
})

// ── requestState ──

describe("requestState", () => {
  test("prefers explicit state", () => {
    expect(requestState(base({ state: "streaming" }))).toBe("streaming")
  })
  test("responseSuccess false → failed", () => {
    expect(requestState(base({ responseSuccess: false }))).toBe("failed")
  })
  test("responseSuccess true → completed", () => {
    expect(requestState(base({ responseSuccess: true }))).toBe("completed")
  })
  test("no signal → pending", () => {
    expect(requestState(base({}))).toBe("pending")
  })
})

// ── isTerminalSummary (gates whether a WS summary belongs to History vs Live) ──

describe("isTerminalSummary", () => {
  test("terminal states are terminal", () => {
    for (const state of ["completed", "failed", "aborted", "interrupted"] as const) {
      expect(isTerminalSummary(base({ state }))).toBe(true)
    }
  })
  test("non-terminal states are not terminal", () => {
    for (const state of ["pending", "executing", "streaming"] as const) {
      expect(isTerminalSummary(base({ state }))).toBe(false)
    }
  })
  test("active flag forces non-terminal even without a non-terminal state", () => {
    // A freshly-created in-flight summary may carry active:true with no state yet.
    expect(isTerminalSummary(base({ active: true }))).toBe(false)
    expect(isTerminalSummary(base({ active: true, state: "completed" }))).toBe(false)
  })
  test("no state and not active → terminal (persisted rows read active:false)", () => {
    expect(isTerminalSummary(base({ active: false }))).toBe(true)
    expect(isTerminalSummary(base({}))).toBe(true)
  })
})

// ── modelName ──

describe("modelName", () => {
  test("responseModel wins over requestModel", () => {
    expect(modelName(base({ responseModel: "resp", requestModel: "req" }))).toBe("resp")
  })
  test("falls back to requestModel", () => {
    expect(modelName(base({ requestModel: "req" }))).toBe("req")
  })
  test("dash when neither", () => {
    expect(modelName(base({}))).toBe("-")
  })
})

// ── endpointLabel ──

describe("endpointLabel", () => {
  test("rawPath used verbatim when present", () => {
    expect(endpointLabel(base({ rawPath: "/v1/messages" }))).toBe("/v1/messages")
  })
  test(String.raw`cleans /v\d+/ prefix and slashes/dashes from endpoint`, () => {
    expect(endpointLabel(base({ endpoint: "anthropic-messages" }))).toBe("anthropic messages")
  })
})

// ── token formatters ──

describe("tokenIn / tokenOut / tokenCacheRead", () => {
  test("dash without usage", () => {
    const e = base({})
    expect(tokenIn(e)).toBe("-")
    expect(tokenOut(e)).toBe("-")
    expect(tokenCacheRead(e)).toBe("-")
  })
  test("formats with usage", () => {
    const e = base({ usage: { input_tokens: 1500, output_tokens: 250, cache_read_input_tokens: 12_000 } })
    expect(tokenIn(e)).toBe("1.5K")
    expect(tokenOut(e)).toBe("250")
    expect(tokenCacheRead(e)).toBe("12.0K")
  })
  test("cacheRead dash when zero / absent", () => {
    expect(tokenCacheRead(base({ usage: { input_tokens: 10, output_tokens: 5 } }))).toBe("-")
    expect(tokenCacheRead(base({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } }))).toBe("-")
  })
})

// ── truncPreview ──

describe("truncPreview", () => {
  test("short text returned unchanged", () => {
    expect(truncPreview(base({ previewText: "hi" }))).toBe("hi")
  })
  test("truncates >120 chars to 117 + ellipsis", () => {
    const long = "a".repeat(200)
    const out = truncPreview(base({ previewText: long }))
    expect(out.length).toBe(120)
    expect(out.endsWith("...")).toBe(true)
  })
  test("falls back to responseError when previewText empty", () => {
    expect(truncPreview(base({ previewText: "", responseError: "boom" }))).toBe("boom")
  })
})

// ── failureSummary ──

describe("failureSummary", () => {
  test("completed → empty string", () => {
    expect(failureSummary(base({ state: "completed" }))).toBe("")
  })
  test("assembles state · strategy · ×N · error", () => {
    const e = base({ state: "failed", currentStrategy: "auto-truncate", attemptCount: 3, responseError: "413 too large" })
    expect(failureSummary(e)).toBe("failed · auto-truncate · ×3 · 413 too large")
  })
  test("interrupted includes pid", () => {
    expect(failureSummary(base({ state: "interrupted", pid: 1234 }))).toBe("interrupted · pid 1234")
  })
})

// ── rowAnomaly ──

describe("rowAnomaly", () => {
  test("slow when duration > 60s", () => {
    expect(rowAnomaly(base({ durationMs: 61_000 })).slow).toBe(true)
    expect(rowAnomaly(base({ durationMs: 60_000 })).slow).toBe(false)
  })
  test("cacheMiss: completed + large input + no cache read", () => {
    const miss = base({ state: "completed", usage: { input_tokens: 30_000, output_tokens: 100 } })
    expect(rowAnomaly(miss).cacheMiss).toBe(true)
  })
  test("no cacheMiss when cache read present", () => {
    const hit = base({ state: "completed", usage: { input_tokens: 30_000, output_tokens: 100, cache_read_input_tokens: 5000 } })
    expect(rowAnomaly(hit).cacheMiss).toBe(false)
  })
  test("no cacheMiss when input below threshold", () => {
    const small = base({ state: "completed", usage: { input_tokens: 10_000, output_tokens: 100 } })
    expect(rowAnomaly(small).cacheMiss).toBe(false)
  })
  test("no cacheMiss when not completed", () => {
    const failed = base({ state: "failed", usage: { input_tokens: 30_000, output_tokens: 100 } })
    expect(rowAnomaly(failed).cacheMiss).toBe(false)
  })
})
