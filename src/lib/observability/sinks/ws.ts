/**
 * WebSocket sink — translates observability events into outbound WS
 * messages on the existing `history` / `status` topics.
 *
 * Replaces the inlined `notifyActiveRequestChanged(...)` calls in
 * `lib/context/manager.ts` and the inlined `notifyEntry*` calls in
 * `lib/history/entries.ts` / `sessions.ts`. The WS wire protocol (the
 * shape of each broadcast message) is unchanged — front-end Vue UI does
 * not need to know that the source moved.
 *
 * Per RFC §6 Q2 the sink also forwards two new event types as broadcast
 * messages: `request.attempt_failed` (for future retry visualization) and
 * `request.feature_applied` (for future feature badges). The current Vue
 * front-end ignores unknown `action` values gracefully, so this is a
 * backward-compatible addition.
 *
 * Commit 2: subscribed but idle — the bus carries no events yet. The
 * existing `notifyActiveRequestChanged` / `notifyEntry*` callers in
 * manager.ts / entries.ts continue to drive broadcasts. Commit 3b /
 * commit 3d switch the producers atomically.
 */

import {
  //
  broadcastAndFlush,
  notifyActiveRequestChanged,
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyHistoryCleared,
  notifyRateLimiterChanged,
  notifySessionDeleted,
  notifyShutdownPhaseChanged,
  notifyStatsUpdated,
} from "~/lib/ws"

import type { ActiveRequestWire } from "../active-request-wire"
import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
  RequestContextSnapshot,
} from "../index"

import { toActiveRequestWire } from "../active-request-wire"
import { assertNever } from "../index"

export class WsSink {
  /**
   * Active request count derived from observed events. Used to populate
   * the `activeCount` field of `notifyActiveRequestChanged` payloads,
   * which today comes from `manager.activeContexts.size`. Commit 3b
   * removes that call site and lets this sink be the sole source.
   */
  private activeCount = 0
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      (event) => this.handle(event),
      // WS cares about every namespace.
      (event) => event.kind.startsWith("request.") || event.kind.startsWith("history.") || event.kind.startsWith("system."),
      { name: "ws-sink" },
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Handle an event. Returns `void` for sync broadcasts and `Promise<void>`
   * for `system.shutdown_phase_changed { needsFlush: true }` — the bus's
   * `publishAndFlush` awaits this promise so shutdown phase frames are
   * guaranteed to leave the box before the next phase advances.
   */
  private handle(event: ObservabilityEvent): void | Promise<void> {
    switch (event.kind) {
      case "request.created": {
        this.activeCount++
        notifyActiveRequestChanged({
          action: "created",
          request: requestPayload(event.ctx),
          activeCount: this.activeCount,
        })
        return
      }
      case "request.state_changed": {
        notifyActiveRequestChanged({
          action: "state_changed",
          request: requestPayload(event.ctx),
          activeCount: this.activeCount,
        })
        return
      }
      case "request.completed":
      case "request.failed":
      case "request.aborted": {
        this.activeCount = Math.max(0, this.activeCount - 1)
        notifyActiveRequestChanged({
          // `event.kind` is narrowed to the three terminal kinds in this case
          // block; `.slice` erases the literal type, so re-narrow to the wire
          // union's `action` (runtime value is identical).
          action: event.kind.slice("request.".length) as "completed" | "failed" | "aborted",
          requestId: event.ctx.id,
          activeCount: this.activeCount,
        })
        return
      }

      // Per RFC §6 Q2: forward attempt_failed and feature_applied as new
      // WS message types. Front-end ignores unknown `action` values.
      case "request.attempt_failed": {
        notifyActiveRequestChanged({
          action: "attempt_failed",
          requestId: event.ctx.id,
          attempt: event.attempt.attemptIndex + 1,
          strategy: event.attempt.strategy,
          willRetry: event.willRetry,
          nextStrategy: event.nextStrategy,
          // The wire contract keeps `waitMs` a required number; the source
          // event has it optional (no backoff on the terminal attempt), so
          // default to 0 here rather than relaxing the wire type.
          waitMs: event.waitMs ?? 0,
          learning: event.learning,
          error: event.attempt.error,
        })
        return
      }
      case "request.feature_applied": {
        notifyActiveRequestChanged({
          action: "feature_applied",
          requestId: event.ctx.id,
          feature: event.feature,
          detail: event.detail,
        })
        return
      }

      // model_resolved / attempt_started / stream_progress are mid-flight
      // signals that the current WS protocol does not surface. Reserved
      // for future use; intentionally silent today.
      //
      // system.diagnostic is for terminal/file sinks only — not broadcast to WS clients.
      // system.request_line is likewise a display-only (stdout/file) synthetic line.
      // system.model_catalog carries complete boot metadata for terminal/file consumers only.
      case "request.model_resolved":
      case "request.attempt_started":
      case "request.stream_progress":
      case "system.diagnostic":
      case "system.model_catalog":
      case "system.request_line": {
        return
      }

      case "history.entry_added": {
        notifyEntryAdded(event.summary)
        return
      }
      case "history.entry_updated": {
        notifyEntryUpdated(event.summary)
        return
      }
      case "history.stats_changed": {
        notifyStatsUpdated(event.stats)
        return
      }
      case "history.cleared": {
        notifyHistoryCleared()
        return
      }
      case "history.session_deleted": {
        notifySessionDeleted(event.sessionId)
        return
      }

      case "system.rate_limit_state": {
        notifyRateLimiterChanged({
          mode: event.mode,
          queuedCount: event.queuedCount,
          ...event.detail,
        })
        return
      }
      case "system.shutdown_phase_changed": {
        if (event.needsFlush) {
          // Returning the promise lets bus.publishAndFlush await the TCP
          // drain. shutdown.ts polls phases that immediately force-close
          // sockets; without flushing here, the phase frame can be lost
          // mid-send and operators see a phase gap in the dashboard.
          return broadcastAndFlush(
            {
              type: "shutdown_phase_changed",
              data: { phase: event.phase, previousPhase: event.previousPhase, needsFlush: event.needsFlush },
              timestamp: Date.now(),
            },
            "status",
          ).then(({ stillBuffering }) => {
            if (stillBuffering > 0) throw new Error(`${stillBuffering} WebSocket client(s) still buffering the shutdown phase after deadline`)
          })
        }
        notifyShutdownPhaseChanged({
          phase: event.phase,
          previousPhase: event.previousPhase,
          needsFlush: event.needsFlush,
        })
        return
      }
      case "system.shutdown_completed": {
        return
      }
      case "system.shutdown_failed": {
        return broadcastAndFlush({ type: "shutdown_failed", data: { errors: event.errors }, timestamp: Date.now() }, "status").then(({ stillBuffering }) => {
          if (stillBuffering > 0) throw new Error(`${stillBuffering} WebSocket client(s) still buffering the shutdown failure after deadline`)
        })
      }
      default: {
        // Exhaustiveness check.
        assertNever(event)
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the WS `request` payload. Projects the ctx snapshot through
 * `toActiveRequestWire` (the single mapper) so this path and the
 * `connected` snapshot factory in start.ts are field-identical — same
 * summary scalars plus the top-level rich fields (method/path/clientModel/
 * resolvedModel/requestBodySize/multiplier; the last two were missing here
 * before). See `lib/observability/active-request-wire.ts`.
 */
function requestPayload(ctx: RequestContextSnapshot): ActiveRequestWire {
  return toActiveRequestWire(ctx)
}

// Re-export types for sink-internal use (helps with downstream consumer typing
// in WsSink-aware tests).

// ============================================================================
// Attachment helper
// ============================================================================

export function attachWsSink(bus: ObservabilityBus): () => void {
  const sink = new WsSink(bus)
  return () => {
    sink.destroy()
  }
}

export { type EntrySummary, type HistoryStats } from "~/lib/history/store"
