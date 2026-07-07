/**
 * End-to-end: the sink → telemetry → read-out chain for thinking-block metrics. A settled
 * `request.completed` event whose recorded upstream leg carries thinking blocks flows through
 * `TelemetrySink` (which calls `extractThinkingBlockCounts`) into the telemetry measures, and the
 * three read-outs — `/api/status` (`getThinkingBlockTotals`), `/api/stats` (`getDimensionBreakdown`),
 * `/metrics` (`buildMetricsExposition`) — all reflect the SAME single-source counts.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntryData } from "~/lib/context/types"
import type { RequestContextSnapshot } from "~/lib/observability"

import { buildMetricsExposition } from "~/lib/metrics-exposition"
import { createBus } from "~/lib/observability"
import { attachTelemetrySink } from "~/lib/observability/sinks/telemetry"
import {
  //
  _resetRequestTelemetryForTests,
  getDimensionBreakdown,
  getThinkingBlockTotals,
} from "~/lib/request-telemetry"

function makeCtx(): RequestContextSnapshot {
  return { id: "ctx-1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "completed", startTime: Date.now(), queueWaitMs: 0 }
}

function makeEntry(content: unknown): HistoryEntryData {
  const now = Date.now()
  return {
    id: "req_1",
    endpoint: "anthropic-messages",
    startedAt: now,
    endedAt: now + 10,
    state: "completed",
    active: false,
    lastUpdatedAt: now + 10,
    queueWaitMs: 0,
    durationMs: 10,
    model: { resolved: "claude-opus-4.8" },
    attempts: [{ index: 0, durationMs: 10, upstreamResponse: { success: true, model: "claude-opus-4.8", usage: { input_tokens: 5, output_tokens: 3 }, body: content } }],
  }
}

describe("thinking-block metrics: sink → telemetry → read-outs", () => {
  beforeEach(() => {
    _resetRequestTelemetryForTests()
  })
  afterEach(() => {
    _resetRequestTelemetryForTests()
  })

  test("a completed Anthropic response with thinking blocks feeds status + stats + metrics read-outs", () => {
    const bus = createBus()
    const detach = attachTelemetrySink(bus)

    const content = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: "s1" }, // nonEmpty
        { type: "thinking", thinking: "", signature: "s2" }, // emptySigned
        { type: "thinking", thinking: "" }, // emptyUnsigned (corrupt double-empty)
        { type: "text", text: "answer" },
      ],
    }
    bus.scope("request").publish({ kind: "request.completed", ctx: makeCtx(), entry: makeEntry(content) })
    detach()

    // /api/status source — global totals via the agentKind-dimension projection.
    expect(getThinkingBlockTotals()).toEqual({ nonEmpty: 1, emptySigned: 1, emptyUnsigned: 1 })

    // /api/stats source — the model-dimension breakdown carries the same measures.
    const model = getDimensionBreakdown("model", "sinceStart").keys.find((k) => k.key === "claude-opus-4.8")
    expect(model?.counters.thinkingBlocksNonEmpty).toBe(1)
    expect(model?.counters.thinkingBlocksEmptySigned).toBe(1)
    expect(model?.counters.thinkingBlocksEmptyUnsigned).toBe(1)

    // /metrics source — the corrupt double-empty block surfaces as a Prometheus counter.
    const text = buildMetricsExposition()
    expect(text).toContain('copilot_api_thinking_blocks_empty_unsigned_total{dimension="model",key="claude-opus-4.8"} 1')
  })

  test("a completed response with no thinking blocks leaves the totals at zero", () => {
    const bus = createBus()
    const detach = attachTelemetrySink(bus)
    bus.scope("request").publish({ kind: "request.completed", ctx: makeCtx(), entry: makeEntry({ role: "assistant", content: "plain text" }) })
    detach()
    expect(getThinkingBlockTotals()).toEqual({ nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 })
  })
})
