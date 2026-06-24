import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { DimensionBreakdownSnapshot } from "~/lib/request-telemetry"

import {
  //
  buildMetricsExposition,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusMetrics,
} from "~/lib/metrics-exposition"
import {
  //
  _resetRequestTelemetryForTests,
  _setRequestTelemetryFilePathForTests,
  recordAcceptedRequest,
  recordSettledRequest,
} from "~/lib/request-telemetry"

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

function breakdown(dimension: string, keys: Array<{ key: string; counters: Record<string, number> }>): DimensionBreakdownSnapshot {
  return {
    dimension,
    window: "sinceStart",
    bucketSizeMinutes: 5,
    windowDays: 7,
    totalKeys: keys.length,
    truncated: false,
    keys: keys.map((k) => ({ ...k, series: [], histograms: {} })),
  }
}

describe("renderPrometheusMetrics", () => {
  test("emits HELP/TYPE + {dimension,key}-labelled counter samples + global accepted", () => {
    const text = renderPrometheusMetrics(
      [breakdown("model", [{ key: "claude-opus-4.8", counters: counters({ requestCount: 3, inputTokens: 100, costInputTokens: 300 }) }])],
      42,
    )
    expect(text).toContain("# TYPE copilot_api_accepted_requests_total counter")
    expect(text).toContain("copilot_api_accepted_requests_total 42")
    expect(text).toContain("# HELP copilot_api_request_count_total")
    expect(text).toContain("# TYPE copilot_api_request_count_total counter")
    expect(text).toContain('copilot_api_request_count_total{dimension="model",key="claude-opus-4.8"} 3')
    expect(text).toContain('copilot_api_input_tokens_total{dimension="model",key="claude-opus-4.8"} 100')
    // per-token cost projected with the snake_case + _total convention
    expect(text).toContain('copilot_api_cost_input_tokens_total{dimension="model",key="claude-opus-4.8"} 300')
    // trailing newline required by the format
    expect(text.endsWith("\n")).toBe(true)
  })

  test("escapes reserved characters in label values (backslash, quote, newline) and strips CR", () => {
    const text = renderPrometheusMetrics([breakdown("client", [{ key: 'we"ird\\ua\nx\ry', counters: counters({ requestCount: 1 }) }])], 0)
    expect(text).toContain(String.raw`key="we\"ird\\ua\nxy"`) // \r stripped, \n escaped
    expect(text).not.toContain("\r")
  })

  test("maps non-finite counter values to the Prometheus spec literals (not JS 'Infinity')", () => {
    const text = renderPrometheusMetrics(
      [breakdown("model", [{ key: "m", counters: counters({ requestCount: Number.NaN, inputTokens: Infinity, outputTokens: -Infinity }) }])],
      0,
    )
    expect(text).toContain('copilot_api_request_count_total{dimension="model",key="m"} NaN')
    expect(text).toContain('copilot_api_input_tokens_total{dimension="model",key="m"} +Inf')
    expect(text).toContain('copilot_api_output_tokens_total{dimension="model",key="m"} -Inf')
    expect(text).not.toContain("Infinity")
  })

  test("a request appears under every dimension (parallel views) with a do-not-sum comment", () => {
    const text = renderPrometheusMetrics(
      [
        breakdown("model", [{ key: "m", counters: counters({ requestCount: 5 }) }]),
        breakdown("endpoint", [{ key: "anthropic-messages", counters: counters({ requestCount: 5 }) }]),
      ],
      5,
    )
    expect(text).toContain("do NOT sum across dimensions")
    expect(text).toContain('copilot_api_request_count_total{dimension="model",key="m"} 5')
    expect(text).toContain('copilot_api_request_count_total{dimension="endpoint",key="anthropic-messages"} 5')
  })

  test("emits a family with HELP/TYPE even when no dimension has any key (stable schema)", () => {
    const text = renderPrometheusMetrics([], 0)
    expect(text).toContain("# TYPE copilot_api_request_count_total counter")
    expect(text).toContain("# TYPE copilot_api_output_tokens_total counter")
  })
})

describe("buildMetricsExposition (live registry)", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-test-"))
    _resetRequestTelemetryForTests()
    _setRequestTelemetryFilePathForTests(path.join(tempDir, "t.json"))
  })

  afterEach(async () => {
    _resetRequestTelemetryForTests()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test("projects the process-lifetime (sinceStart) counters across registered dimensions", () => {
    const now = Date.now()
    recordAcceptedRequest(now)
    recordSettledRequest(
      { model: "claude-opus-4.8", endpoint: "anthropic-messages", agentKind: "main" },
      { startedAt: now, endedAt: now + 100, success: true, multiplier: 1, usage: { input_tokens: 50, output_tokens: 10 } },
    )
    const text = buildMetricsExposition(now)
    expect(text).toContain("copilot_api_accepted_requests_total 1")
    expect(text).toContain('copilot_api_request_count_total{dimension="model",key="claude-opus-4.8"} 1')
    expect(text).toContain('copilot_api_input_tokens_total{dimension="endpoint",key="anthropic-messages"} 50')
    expect(text).toContain('copilot_api_request_count_total{dimension="agentKind",key="main"} 1')
    // multiplier 1 → cost == tokens
    expect(text).toContain('copilot_api_cost_input_tokens_total{dimension="model",key="claude-opus-4.8"} 50')
  })

  test("content-type is the Prometheus v0.0.4 exposition type", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8")
  })

  test("emits standard Prometheus histograms (cumulative _bucket{le} + _sum + _count)", () => {
    const now = Date.now()
    for (let i = 0; i < 4; i++) recordSettledRequest({ model: "claude-opus-4.8" }, { startedAt: now, endedAt: now + 50, success: true })
    const text = buildMetricsExposition(now)
    expect(text).toContain("# TYPE copilot_api_duration_ms histogram")
    // 50ms → bucket le="50"; cumulative count reaches 4 by le="50" and stays 4 at +Inf.
    expect(text).toContain('copilot_api_duration_ms_bucket{dimension="model",key="claude-opus-4.8",le="50"} 4')
    expect(text).toContain('copilot_api_duration_ms_bucket{dimension="model",key="claude-opus-4.8",le="+Inf"} 4')
    expect(text).toContain('copilot_api_duration_ms_sum{dimension="model",key="claude-opus-4.8"} 200')
    expect(text).toContain('copilot_api_duration_ms_count{dimension="model",key="claude-opus-4.8"} 4')
  })
})
