import {
  //
  describe,
  expect,
  test,
} from "vitest"

import type {
  //
  DimensionBreakdownSnapshot,
  HistogramSummary,
} from "@/types"

import DashboardBreakdownPanel from "@/components/dashboard/DashboardBreakdownPanel.vue"

import {
  //
  mountWithVuetifyStubs,
  vuetifyComponentStubs,
} from "./helpers/mount"

const VSheetStub = { name: "VSheet", template: "<section><slot /></section>" }
const VProgressLinearStub = { name: "VProgressLinear", props: ["modelValue"], template: "<div class='bar' :data-value='modelValue' />" }

function counters(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costInputTokens: 0,
    costOutputTokens: 0,
    costCacheReadInputTokens: 0,
    costCacheCreationInputTokens: 0,
    costReasoningTokens: 0,
    ...overrides,
  }
}

function latency(p50: number, p95: number): HistogramSummary {
  return { count: 10, sum: p50 * 10, average: p50, p50, p90: p95, p95, p99: p95, boundaries: [50, 100, 250], buckets: [5, 5, 0, 0] }
}

function breakdown(): DimensionBreakdownSnapshot {
  return {
    dimension: "agentKind",
    window: "7d",
    bucketSizeMinutes: 5,
    windowDays: 7,
    totalKeys: 2,
    truncated: false,
    keys: [
      {
        key: "main",
        counters: counters({ requestCount: 18, inputTokens: 1000, outputTokens: 400 }),
        series: [],
        histograms: { duration_ms: latency(40, 180) },
      },
      { key: "subagent", counters: counters({ requestCount: 7, inputTokens: 300, outputTokens: 120 }), series: [], histograms: {} },
    ],
  }
}

function mountPanel(props: { eyebrow: string; title: string; breakdown: DimensionBreakdownSnapshot | null; metric?: string; emptyText?: string }) {
  return mountWithVuetifyStubs(DashboardBreakdownPanel, {
    props,
    global: { components: { ...vuetifyComponentStubs, VSheet: VSheetStub, VProgressLinear: VProgressLinearStub } },
  })
}

describe("DashboardBreakdownPanel", () => {
  test("renders one row per breakdown key with its metric value", () => {
    const w = mountPanel({ eyebrow: "Disposition", title: "Main vs Subagent", breakdown: breakdown() })
    const text = w.text()
    expect(text).toContain("Main vs Subagent")
    expect(text).toContain("main")
    expect(text).toContain("subagent")
    expect(text).toContain("18") // main requestCount (default metric)
    expect(text).toContain("7") // subagent requestCount
  })

  test("surfaces p50/p95 latency when the key carries a duration histogram", () => {
    const w = mountPanel({ eyebrow: "x", title: "y", breakdown: breakdown() })
    const text = w.text()
    expect(text).toContain("p50 40ms")
    expect(text).toContain("p95 180ms")
  })

  test("bar share is normalized to the max metric value (top key fills 100%)", () => {
    const w = mountPanel({ eyebrow: "x", title: "y", breakdown: breakdown() })
    const bars = w.findAll(".bar")
    expect(bars.length).toBe(2)
    expect(bars[0].attributes("data-value")).toBe("100") // main is the max → 100%
  })

  test("shows the empty state when the breakdown is null", () => {
    const w = mountPanel({ eyebrow: "x", title: "y", breakdown: null, emptyText: "Nothing here" })
    expect(w.text()).toContain("Nothing here")
  })
})
