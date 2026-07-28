/**
 * Telemetry sink — records settled `request.completed` / `request.failed`
 * events into `lib/request-telemetry.ts` for per-model success/failure
 * counters.
 *
 * Aborted requests are NOT counted (a client disconnect is not a verdict
 * on the model/upstream; counting would skew per-model success rate).
 * Mirrors the existing carve-out in `lib/context/manager.ts:264-289`.
 *
 * Replaces the inlined `recordSettledFromEntry(...)` call in
 * `manager.ts` (lines 199-205, 239, 256). Commit 3b removes the manager
 * call sites and lets this sink be the sole telemetry recorder.
 *
 * Commit 2: subscribed but idle — bus carries no terminal events yet.
 */

import { CAPPED_DIMENSION_NAMES } from "@hsupu/ghc-proxy-telemetry"
import { peekTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "../index"

import {
  //
  extractTelemetryKeys,
  extractThinkingBlockCounts,
} from "../telemetry-dimensions"

export class TelemetrySink {
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      (event) => {
        this.handle(event)
      },
      // Only the two terminal kinds matter — aborted intentionally excluded.
      (event) => event.kind === "request.completed" || event.kind === "request.failed",
      { name: "telemetry-sink" },
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  private handle(event: ObservabilityEvent): void {
    if (event.kind !== "request.completed" && event.kind !== "request.failed") return

    const entry = event.entry
    // The settled verdict/usage live on the final attempt's `upstreamResponse` leg
    // (`_index.derived.responseSuccess` when the producer wires it).
    const attempts = entry.attempts ?? []
    const committedAttempt = attempts.find((attempt) => attempt.dispatchVerdict === "committed") ?? attempts.at(-1)
    const finalUpstream = committedAttempt?.upstreamResponse
    const candidateIds = new Set(attempts.flatMap((attempt) => (attempt.candidateId ? [attempt.candidateId] : [])))
    const hedgeIds = new Set(attempts.flatMap((attempt) => (attempt.candidateRole === "hedge" && attempt.candidateId ? [attempt.candidateId] : [])))
    const recoveryIds = new Set(attempts.flatMap((attempt) => (attempt.candidateRole === "recovery" && attempt.candidateId ? [attempt.candidateId] : [])))
    peekTelemetryRuntime()?.recordSettled(
      extractTelemetryKeys(entry, event.ctx),
      {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        // The REQUEST VERDICT, not the upstream leg. `responseSuccess` / `finalUpstream.success` are
        // deliberately `true` for a proxy-introduced failure (a suppressed contentless refusal, an
        // unrepairable tool_use) because the upstream leg genuinely succeeded — reading them here
        // recorded a `request.failed` as a telemetry success. Leg health stays observable on the
        // History entry; this registry counts whether the CLIENT's request succeeded.
        success: event.kind === "request.completed",
        usage: finalUpstream?.usage,
        // Per-token cost: the billing multiplier rides on the ctx snapshot
        // (state.modelIndex-resolved), not the entry. Undefined for token-based accounts.
        multiplier: event.ctx.multiplier,
        // Queue-wait distribution: time spent queued by the rate limiter before dispatch.
        queueWaitMs: entry.queueWaitMs,
        // Per-request thinking-block emptiness tally (single-point extraction from the recorded
        // upstream leg; feeds the thinkingBlocks* feature measures across every dimension).
        thinkingBlocks: extractThinkingBlockCounts(entry),
        // 首包埋点（spec 2026-07-14 §6.1）：时序度量（ms，相对 started_at）喂 DDSketch 分布。
        // committed attempt 的上游 epoch 减 started_at 得真 TTFT；client 3 刻已是 offset。
        ...(committedAttempt?.upstreamFirstTokenAt !== undefined && { upstreamFirstTokenMs: committedAttempt.upstreamFirstTokenAt - entry.startedAt }),
        ...(entry.timing?.client?.firstRealMs !== undefined && { clientFirstRealMs: entry.timing.client.firstRealMs }),
        ...(entry.timing?.client?.firstRealMs !== undefined
          && entry.timing.client.bufferHoldStartMs !== undefined && { bufferHoldMs: entry.timing.client.firstRealMs - entry.timing.client.bufferHoldStartMs }),
        generation: {
          candidates: candidateIds.size,
          dispatches: attempts.length,
          hedgeCandidates: hedgeIds.size,
          hedgeWins: attempts.some((attempt) => attempt.candidateRole === "hedge" && attempt.candidateVerdict === "winner") ? 1 : 0,
          recoveryCandidates: recoveryIds.size,
          cancelledDispatches: attempts.filter((attempt) => attempt.dispatchVerdict === "cancelled").length,
          unknownUsageDispatches: attempts.filter((attempt) => attempt.dispatchVerdict !== "committed" && attempt.upstreamResponse?.usage === undefined).length,
        },
      },
      CAPPED_DIMENSION_NAMES,
    )
  }
}

export function attachTelemetrySink(bus: ObservabilityBus): () => void {
  const sink = new TelemetrySink(bus)
  return () => {
    sink.destroy()
  }
}
