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
  RequestState,
} from "~/lib/context/types"
import type { DiagnosticEvent } from "~/lib/diagnostics"
import type {
  //
  EntrySummary,
  HistoryStats,
} from "~/lib/history/store"
import type { EndpointType } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { LogLineParts } from "~/lib/observability/projections/log-line"

// Re-export the single source of truth so consumers of the observability
// barrel get the type without reaching into context internals.
export type { RequestActivitySnapshot } from "~/lib/context/activity-summary"

/** Immutable snapshot of a RequestContext at the moment the event is emitted. */
export interface RequestContextSnapshot {
  id: string
  endpoint: EndpointType
  sessionId?: string
  /** Subagent id (`x-claude-code-agent-id`); absent for the main agent. Carried so display sinks can render the session-identity block. */
  agentId?: string
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
  /** downstream owner crossed its wire commit point before delivery failed */
  | "wire-partial-delivery"
  /** recoverer rebuilt tool_use(s) from downgraded upstream text — `detail: { tools: string[] }` (the recovered tool names, in call order) */
  | "tool-call-recovered"
  /** suppression mode: a contentless upstream refusal was rewritten into a normal completed turn so
   *  the client's conversation is not interrupted (the request still settles FAILED).
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-recovered"
  /** error mode: surfaced a contentless upstream refusal as an `event: error` frame + ctx.fail.
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-errored"
  /** passthrough mode: the genuine upstream refusal reached the client untouched (still settles FAILED).
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-passthrough"
  /** error-shaping 决策命中 — detail: { decision: "retry-signal"|"ask-user-question"|"canonical-error"|"defer-to-block-level", errorType: ApiErrorType, commitPhase: "pre-commit"|"post-commit" } */
  | "error-shaping-decided"
  /** error-shaping B类 AskUserQuestion 合成命中 — detail: { errorType: ApiErrorType } */
  | "error-shaping-auq-synthesized"
  /** error-shaping D类自愈委派命中（策略被强制 canHandle=false）— detail: { strategyName: string } */
  | "error-shaping-selfheal-delegated"
  /** raw-stream canonical error 终点整形命中（H3 stream-error / truncation × direct/translate 腿）——
   * detail: { wireErrorType: string, terminus: "stream-error"|"truncation", leg: "direct"|"translate" }.
   * `wireErrorType` 是 wire 级字符串（非 error-shaping-decided 的 ApiErrorType 枚举——同名会混值域）。 */
  | "error-shaping-raw-canonical"
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
  /**
   * translation matrix: a forward-leg (anthropic→cc/responses) upstream choice finished with
   * `content_filter`, which has no Anthropic stop_reason and was mapped to `end_turn` on the client
   * wire (N3) — this marker keeps the degradation observably distinguishable (richest-data-flow). `detail: {}`.
   */
  | "translated-content-filter"
  /** reverse translation mapped an Anthropic refusal to a target protocol that cannot carry
   *  `stop_details.category`. `detail: { category, target: "openai-cc"|"openai-responses" }`. */
  | "translated-refusal-category-dropped"

export type TransportKind = "http" | "upstream-ws" | "upstream-ws-fallback"

export type ShutdownPhase = "draining" | "finalized"

export type RateLimitMode = "normal" | "rate-limited" | "recovering"

export interface ModelCatalogEntry {
  model: Model
  disabled: boolean
}

export interface ModelCatalogData {
  models: ReadonlyArray<ModelCatalogEntry>
  tokenBasedBilling: boolean
  timeUnixMs: number
}

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
  | { kind: "system.shutdown_failed"; errors: ReadonlyArray<{ name: string; message: string }> }

  // ── Complete upstream model catalog. Consumers decide presentation: the
  //    Terminal applies colors/alignment, while the structured file retains
  //    full model metadata without parsing a pre-rendered text table. ──
  | ({ kind: "system.model_catalog" } & ModelCatalogData)

  // ── Synthetic request-style log line (out-of-observability helpers) ──
  //    A pre-built request-line projection for routes that are deliberately
  //    exempt from the full request lifecycle (count_tokens — see
  //    observability/middleware.ts SYNTHETIC_PATHS) but still want to render a
  //    request-shaped line instead of a `[INFO]` syslog line. Carries the same
  //    `LogLineParts` a real `request.completed` renders, but creates NO
  //    RequestContext and reaches ONLY the display sinks (TerminalUi stdout +
  //    FileSink) — never history / telemetry / calibration / WS. ──
  | { kind: "system.request_line"; parts: LogLineParts }

  // ── Non-HTTP console logs (republished from consola — the single hijack
  //    point lives in `observability/republish.ts`, installed by start.ts).
  //    Consumed by ConsoleSink (stdout, footer-coordinated) and FileSink
  //    (copilot-api.log). `message` is the args pre-joined by the reporter so
  //    both sinks share one representation; `logType` is the consola level name
  //    ("info" | "warn" | "error" | "success" | "debug" | …) for prefix
  //    selection; `time` is the log timestamp in epoch ms. ──
  | { kind: "system.diagnostic"; diagnostic: DiagnosticEvent }

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
