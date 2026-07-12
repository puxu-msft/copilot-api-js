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
  RequestActivitySnapshot,
} from "~/lib/context/activity-summary"
import type {
  //
  HistoryEntryData,
  RequestContext,
  RequestState,
} from "~/lib/context/types"
import type {
  //
  EntrySummary,
  HistoryStats,
} from "~/lib/history/store"
import type { EndpointType } from "~/lib/history/types"

// Re-export the single source of truth so consumers of the observability
// barrel get the type without reaching into context internals.
export type { RequestActivitySnapshot } from "~/lib/context/activity-summary"

/**
 * Opaque reference to a live RequestContext. Used only by the
 * `request.context_updated` event for HistorySink (the only synchronous
 * field-update consumer). Typed via `import type` from `~/lib/context/types`
 * — TypeScript's type-only import does NOT create a runtime dependency, so
 * the apparent `context → observability → context` cycle is type-erased
 * at compile time and doesn't exist at runtime.
 *
 * Prefer this over an `unknown` + `as RequestContext` cast — that cast
 * abandons type safety to dodge a runtime cycle that does not exist. To
 * confirm no real cycle after a type-only import: `bun run typecheck` (types
 * OK) + `bun test` (runtime OK), and `grep -n "^import " <both files>` to
 * check the suspect direction is `import type` only.
 */
export type RequestContextLive = RequestContext

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
  /** 当前在途 attempt 的 startTime（footer/panel 用；轻量 snapshot() 每事件填充，故高频 stream_progress 也带）。 */
  currentAttemptStartedAt?: number
  /** 已发生的 attempt 数（_attempts.length）；footer/panel 算 retries=attemptCount-1。 */
  attemptCount?: number
  /**
   * Activity summary (the `summarizeRequestContext(ctx)` shape used by the
   * front-end's WS activity view). Populated by the producer (manager.ts)
   * for lifecycle/state-change events so WsSink can forward it to clients
   * without re-deriving from a live ctx. Undefined for events where the
   * full activity summary isn't meaningful (e.g. `feature_applied`).
   */
  summary?: RequestActivitySnapshot
}

// (RequestActivitySnapshot is re-exported above from ~/lib/context/activity-summary
// — single source of truth, no duplication.)

/**
 * Partial attempt snapshot — carried on attempt-level events so debugging-level
 * sinks can read every diagnostic field the `Attempt` type holds without
 * dereferencing the live RequestContext (which may have mutated since).
 */
export interface AttemptSnapshot {
  attemptIndex: number
  /** 本次 attempt 自身的墙钟耗时（ms）——由 setAttemptError / setAttemptResponse 定稿。供 [RETRY] 行作 lastMs。 */
  durationMs?: number
  strategy?: string
  transport?: TransportKind
  /** Exact payload sent upstream (post-sanitize/truncate). */
  wireRequest?: unknown
  effectiveRequest?: unknown
  /** Bytes/events received before failure (for streaming attempts). */
  partialResponse?: unknown
  error?: { status: number; message: string; type: string; rawBody?: string }
}

/** Feature kinds — replaces the legacy `tags: string[]` escape hatch. */
export type FeatureKind =
  /** auto-truncate ran */
  | "truncated"
  /**
   * Thinking mode as a per-request terminal dimension —
   * `detail: { requested?: string, effective: string }`. `effective` is the
   * final outbound wire `thinking.type` (post coerceAdaptiveThinking); `requested`
   * is the client's original `thinking.type`. They differ when the pipeline
   * coerced it (e.g. `enabled`→`adaptive`). Scope: top-level `thinking.type` only
   * (budget_tokens / output_config.effort coercions are not surfaced here).
   */
  | "thinking"
  /** unsupported-beta strategy stripped headers — `detail: { betas: string[] }` */
  | "beta-stripped"
  /** passthrough 剥掉 GHC 未支持的 cache_control 子字段（如 scope）— `detail: { fields: string[] }` */
  | "cache-control-stripped"
  /** responses → chat-completions fallback */
  | "via-chat-completions-fallback"
  /** chat-completions → responses (reverse fallback) */
  | "via-responses"
  /** sanitize dropped unsupported params — `detail: { params: string[] }` */
  | "dropped-params"
  /** request used a non-default transport — `detail: { kind: TransportKind }` */
  | "transport"
  /** streaming recoverer rebuilt a tool_use from downgraded upstream text */
  | "tool-call-recovered"
  /** recovered a thinking-only upstream refusal by synthesizing a text completion */
  | "refusal-recovered"
  /** error mode: surfaced a thinking-only upstream refusal as an `event: error` frame + ctx.fail */
  | "refusal-errored"
  /** a tool_use input field selected for decode couldn't be decoded — `detail: { tool, field?, reason }` */
  | "tool-input-decode-failed"
  /** L2 buffered-retry resolution — `detail: { outcome: "success"|"exhausted"|"retreated", retries: number }` */
  | "protect-streaming-retry"
  /** Streaming keepalive: proxy opened a 200 SSE stream on request receipt and started the connection-
   *  level heartbeat immediately, decoupled from the upstream. `detail: {}`. */
  | "stream-immediate-keepalive"
  /** Upstream resolved after the immediate keepalive commit — `detail: { totalStalledMs: number }`. */
  | "stream-upstream-resolved"
  /**
   * Upstream applied context_management edits — its authoritative receipt that our injected
   * `context_management` (context_editing / L2 escalation) actually cleared context.
   * `detail: { count: number, clearedInputTokens: number, types: string[] }`. Only recorded when
   * `applied_edits` is non-empty (an empty receipt means upstream cleared nothing).
   */
  | "context-edits-applied"
  /** a malformed tool_use input was repaired before forwarding — `detail: { tool, layer: "tags"|"repair" }` */
  | "tool-input-repaired"
  /** a malformed tool_use input could not be repaired (strip + jsonrepair both failed) — `detail: { tool }` */
  | "tool-input-unrepairable"

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

  // ── Internal field mutation signal for HistorySink (synchronous consumers only) ──
  //
  // This event is the bus equivalent of the legacy
  // `RequestContextEvent.updated { field }` signal in `lib/context/manager.ts`.
  // HistorySink consumes it synchronously to mirror originalRequest / attempts
  // / queueWaitMs / pipelineInfo / warningMessages updates into SQLite. It
  // carries the **live RequestContextRef** (not just the snapshot) because
  // `buildHistoryActivityPatch(context)` and `collectAttemptStages(context)`
  // need the full mutable shape.
  //
  // CONTRACT: subscribers MUST read `contextRef` synchronously and not retain
  // the reference. Async sinks should ignore this event and subscribe to the
  // strongly-typed signals (`feature_applied`, `attempt_started`,
  // `state_changed`, etc.) instead. WsSink does not subscribe to this event.
  // ConsoleSink does not subscribe to it. Only HistorySink does.
  | { kind: "request.context_updated"; ctx: RequestContextSnapshot; field: string; contextRef: RequestContextLive }

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

  // ── Non-HTTP console logs (republished from consola — the single hijack
  //    point lives in `observability/republish.ts`, installed by start.ts).
  //    Consumed by ConsoleSink (stdout, footer-coordinated) and FileSink
  //    (copilot-api.log). `message` is the args pre-joined by the reporter so
  //    both sinks share one representation; `logType` is the consola level name
  //    ("info" | "warn" | "error" | "success" | "debug" | …) for prefix
  //    selection; `time` is the log timestamp in epoch ms. ──
  | { kind: "system.log"; logType: string; message: string; time: number }

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
