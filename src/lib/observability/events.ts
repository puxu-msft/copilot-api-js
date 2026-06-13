/**
 * Canonical event union for the observability subsystem.
 *
 * Every request-lifecycle, history-persistence, and system-level signal
 * flows through this discriminated union published on the central bus.
 * Sinks (console, ws, history, telemetry) subscribe to the bus and use
 * exhaustive `switch (event.kind)` with a `default: assertNever(event)`
 * so adding a new kind without updating sinks fails `tsc`.
 *
 * Design properties:
 * - `ctx` snapshot is value-typed (`RequestContextSnapshot`); sinks never
 *   close over mutable RequestContext to avoid mid-flight mutations
 *   leaking into past events.
 * - Terminal events carry the full `HistoryEntryData` so sinks need not
 *   crawl back to RequestContext to reconstruct it.
 * - Attempt-level events carry `AttemptSnapshot` with wireRequest /
 *   effectiveRequest / partialResponse / error so debugging-level sinks
 *   can introspect mid-flight (原则7).
 * - The `tags: string[]` escape hatch is gone — features are first-class
 *   `request.feature_applied` events with a discriminated `FeatureKind`.
 * - `/v1/messages/count_tokens` is intentionally OUT of observability per
 *   user decision (RFC §6 Q1): no event kind models it. Synthetic routes
 *   are skipped by the middleware (see `lib/observability/middleware.ts`
 *   to be added in commit 3e).
 *
 * Namespacing: `request.*` is published only by `lib/context/manager.ts`
 * (via the injected `ScopedPublisher<"request">`), `history.*` only by
 * `lib/history/*` (via the injected `ScopedPublisher<"history">`), and
 * `system.*` only by `lib/shutdown.ts` / `lib/adaptive-rate-limiter.ts`
 * (via the injected `ScopedPublisher<"system">`). The type system
 * enforces ownership at publish time (see `bus.ts`).
 */

import type {
  //
  HistoryEntryData,
  RequestState,
} from "~/lib/context/types"
import type {
  //
  EntrySummary,
  HistoryStats,
} from "~/lib/history/store"
import type { EndpointType } from "~/lib/history/types"

/** Immutable snapshot of a RequestContext at the moment the event is emitted. */
export interface RequestContextSnapshot {
  id: string
  endpoint: EndpointType
  sessionId?: string
  rawPath?: string
  /** HTTP method, or "WS" / "STDIO" for non-HTTP entry points. */
  method: string
  path: string
  clientModel?: string
  resolvedModel?: string
  state: RequestState
  startTime: number
  queueWaitMs: number
  requestBodySize?: number
  /** Pre-resolved billing multiplier (from state.modelIndex) for display. */
  multiplier?: number
}

/**
 * Partial attempt snapshot — carried on attempt-level events so debugging-level
 * sinks can read every diagnostic field the `Attempt` type holds without
 * dereferencing the live RequestContext (which may have mutated since).
 */
export interface AttemptSnapshot {
  attemptIndex: number
  strategy?: string
  transport?: TransportKind
  /** Exact payload sent upstream (post-sanitize/truncate). */
  wireRequest?: unknown
  effectiveRequest?: unknown
  /** Bytes/events received before failure (for streaming attempts). */
  partialResponse?: unknown
  error?: { status: number; message: string; type: string }
}

/** Feature kinds — replaces the legacy `tags: string[]` escape hatch. */
export type FeatureKind =
  /** auto-truncate ran */
  | "truncated"
  /** adaptive/enabled thinking — `detail: { type: "adaptive" | "enabled" }` */
  | "thinking"
  /** upstream thinking coercion — `detail: { type: string }` */
  | "thinking-wire"
  /** unsupported-beta strategy stripped headers — `detail: { betas: string[] }` */
  | "beta-stripped"
  /** responses → chat-completions fallback */
  | "via-chat-completions-fallback"
  /** chat-completions → responses (reverse fallback) */
  | "via-responses"
  /** sanitize dropped unsupported params — `detail: { params: string[] }` */
  | "dropped-params"
  /** request used a non-default transport — `detail: { kind: TransportKind }` */
  | "transport"

export type TransportKind = "http" | "upstream-ws" | "upstream-ws-fallback"

export type ShutdownPhase = "draining" | "aborting" | "finalized"

export type RateLimitMode = "normal" | "rate-limited" | "recovering"

/**
 * The canonical event union. Every event has `kind: "<namespace>.<verb>"`
 * so `ScopedPublisher<NS>` can type-restrict publishes via template
 * literals (`Extract<ObservabilityEvent, { kind: \`${NS}.${string}\` }>`).
 */
export type ObservabilityEvent =
  // ── Request lifecycle (1:1 with the existing RequestContextEvent union) ──
  | { kind: "request.created"; ctx: RequestContextSnapshot }
  | { kind: "request.model_resolved"; ctx: RequestContextSnapshot }
  | { kind: "request.state_changed"; ctx: RequestContextSnapshot; previousState: RequestState; meta?: Record<string, unknown> }

  // ── Attempt-level (replaces pipeline.logRetry + consumers.attempts update) ──
  | { kind: "request.attempt_started"; ctx: RequestContextSnapshot; attempt: AttemptSnapshot }
  | {
      kind: "request.attempt_failed"
      ctx: RequestContextSnapshot
      attempt: AttemptSnapshot
      willRetry: boolean
      nextStrategy?: string
      waitMs?: number
      learning?: boolean
    }

  // ── Streaming progress (all fields optional — not every transport reports all) ──
  | { kind: "request.stream_progress"; ctx: RequestContextSnapshot; bytesIn?: number; eventsIn?: number; blockType?: string }

  // ── Feature applications (replaces tags: string[]) ──
  | { kind: "request.feature_applied"; ctx: RequestContextSnapshot; feature: FeatureKind; detail?: Record<string, unknown> }

  // ── Terminal (emitted by manager only) ──
  | { kind: "request.completed"; ctx: RequestContextSnapshot; entry: HistoryEntryData }
  | { kind: "request.failed"; ctx: RequestContextSnapshot; entry: HistoryEntryData; error: string; statusCode?: number }
  | { kind: "request.aborted"; ctx: RequestContextSnapshot; entry: HistoryEntryData }

  // ── History persistence (emitted by lib/history/* via injected ScopedPublisher<"history">) ──
  | { kind: "history.entry_added"; summary: EntrySummary }
  | { kind: "history.entry_updated"; summary: EntrySummary }
  | { kind: "history.stats_changed"; stats: HistoryStats }
  | { kind: "history.cleared" }
  | { kind: "history.session_deleted"; sessionId: string }

  // ── System-level (shutdown / rate-limiter) ──
  | { kind: "system.rate_limit_state"; mode: RateLimitMode; queuedCount: number; detail?: Record<string, unknown> }
  | { kind: "system.shutdown_phase_changed"; phase: ShutdownPhase; previousPhase: ShutdownPhase | null; needsFlush: boolean }
  | { kind: "system.shutdown_completed" }

/** Top-level namespace prefix of an event kind. */
export type EventNamespace = "request" | "history" | "system"

/** All event kinds in the union — useful for filter type narrowing. */
export type EventKind = ObservabilityEvent["kind"]

/**
 * Helper for exhaustive switches in sinks.
 * Throws at runtime if a sink missed a kind (which is also a compile error
 * because the parameter type narrows to `never` only when all cases are
 * handled).
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled observability event variant: ${JSON.stringify(value)}`)
}
