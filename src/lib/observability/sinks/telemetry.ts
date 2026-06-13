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

import { recordSettledRequest } from "~/lib/request-telemetry"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "../index"

export class TelemetrySink {
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      (event) => {
        this.handle(event)
      },
      // Only the two terminal kinds matter — aborted intentionally excluded.
      (event) => event.kind === "request.completed" || event.kind === "request.failed",
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  private handle(event: ObservabilityEvent): void {
    if (event.kind !== "request.completed" && event.kind !== "request.failed") return

    const entry = event.entry
    recordSettledRequest(entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown", {
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      success: entry.outboundResponse?.success ?? event.kind === "request.completed",
      usage: entry.outboundResponse?.usage,
    })
  }
}

export function attachTelemetrySink(bus: ObservabilityBus): () => void {
  const sink = new TelemetrySink(bus)
  return () => {
    sink.destroy()
  }
}
