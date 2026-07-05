import {
  //
  describe,
  expect,
  test,
} from "vitest"

import type { UnmatchedTelemetryRow } from "@/composables/model-telemetry-join"

import UnmatchedTelemetrySection from "@/components/models/UnmatchedTelemetrySection.vue"

import { mountWithVuetifyStubs } from "./helpers/mount"

const row = (model: string, requestCount: number, failureCount: number): UnmatchedTelemetryRow => ({
  model,
  normalizedKey: model,
  last7d: {
    model,
    requestCount,
    successCount: requestCount - failureCount,
    failureCount,
    totalDurationMs: 0,
    averageDurationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
  },
  sinceStart: null,
})

describe("UnmatchedTelemetrySection", () => {
  test("renders unmatched rows with counts", () => {
    const w = mountWithVuetifyStubs(UnmatchedTelemetrySection, { props: { rows: [row("opus", 3, 3)] } })
    expect(w.text()).toContain("opus")
    expect(w.text()).toContain("3")
  })

  test("renders nothing when rows are empty", () => {
    const w = mountWithVuetifyStubs(UnmatchedTelemetrySection, { props: { rows: [] } })
    expect(w.text()).not.toMatch(/unmatched/i)
  })
})
