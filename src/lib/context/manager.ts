/**
 * RequestContextManager — Active request management
 *
 * Manages all in-flight RequestContext instances. Publishes events for
 * WebSocket push and history persistence. The "active layer" complementing
 * the history store (persistence layer).
 *
 * Data flow:
 *   Handler creates RequestContext → manager.create() registers + emits "created"
 *   → pipeline processes request, calls ctx.transition()/setPipelineInfo()/etc
 *   → each change → manager emits events
 *   → ws receives events → pushes to browser
 *   → ctx.complete()/fail() → ctx.toHistoryEntry() → store.insert()
 *   → manager emits "completed"/"failed" → removes active context
 */

import { consola } from "consola"

import type { EndpointType } from "~/lib/history/store"
import type {
  //
  RequestContextSnapshot,
  ScopedPublisher,
} from "~/lib/observability"

import { recordAcceptedRequest } from "~/lib/request-telemetry"
import { state } from "~/lib/state"

import type {
  //
  HistoryEntryData,
  RequestContext,
  RequestContextEventData,
  RequestState,
} from "./request"

import { summarizeRequestContext } from "./activity-summary"
import { createRequestContext } from "./request"

// ─── Event Types ───

export type RequestContextEvent =
  | { type: "created"; context: RequestContext }
  | { type: "state_changed"; context: RequestContext; previousState: RequestState; meta?: Record<string, unknown> }
  | { type: "updated"; context: RequestContext; field: string }
  | { type: "completed"; context: RequestContext; entry: HistoryEntryData }
  | { type: "failed"; context: RequestContext; entry: HistoryEntryData }
  | { type: "aborted"; context: RequestContext; entry: HistoryEntryData }

// ─── Manager Interface ───

export interface RequestContextManager {
  /** Create and register a new active request context */
  create(opts: {
    endpoint: EndpointType
    sessionId?: string
    rawPath?: string
    /**
     * HTTP method of the inbound request. Stored on RequestContext.method
     * for sinks to render. Default "UNKNOWN" if omitted.
     */
    method?: string
    /** Inbound URL path. Default "/" if omitted. */
    path?: string
    /** Inbound Content-Length header value, if present. */
    requestBodySize?: number
  }): RequestContext

  /** Get an active request by ID */
  get(id: string): RequestContext | undefined

  /** Get all active requests (for history UI real-time view) */
  getAll(): Array<RequestContext>

  /** Number of active requests */
  readonly activeCount: number

  /** Subscribe to context events */
  on(event: "change", listener: (event: RequestContextEvent) => void): void

  /** Unsubscribe from context events */
  off(event: "change", listener: (event: RequestContextEvent) => void): void

  /** Start periodic cleanup of stale active contexts */
  startReaper(): void

  /** Stop the reaper (for shutdown/cleanup) */
  stopReaper(): void

  /** Run a single reaper scan (exposed for testing) */
  _runReaperOnce(): void
}

// ─── Implementation ───

// ─── Module-level Singleton ───

let _manager: RequestContextManager | null = null

export interface RequestContextManagerOptions {
  /**
   * Scoped publisher for `request.*` ObservabilityEvent emissions, passed
   * through to every `createRequestContext` call so the new emit methods
   * (`setResolvedModel`, `recordFeature`, etc. — added in commit 3a)
   * publish to the bus. Optional during commits 3a/3b; required from
   * commit 3b onward when the producer fully cuts over.
   */
  publisher?: ScopedPublisher<"request">
}

export function initRequestContextManager(options?: RequestContextManagerOptions): RequestContextManager {
  _manager = createRequestContextManager(options)
  return _manager
}

export function getRequestContextManager(): RequestContextManager {
  if (!_manager) throw new Error("RequestContextManager not initialized — call initRequestContextManager() first")
  return _manager
}

export function resetRequestContextManagerForTests(options?: RequestContextManagerOptions): RequestContextManager {
  _manager?.stopReaper()
  _manager = createRequestContextManager(options)
  return _manager
}

// ─── Factory ───

export function createRequestContextManager(options?: RequestContextManagerOptions): RequestContextManager {
  const activeContexts = new Map<string, RequestContext>()
  const listeners = new Set<(event: RequestContextEvent) => void>()
  const publisher = options?.publisher

  // ─── Stale Request Reaper ───

  /**
   * Cap on the reaper scan interval. A scan misses stale work for at most
   * `interval` ms, so we derive the effective interval from staleRequestMaxAge
   * — but clamp to this cap so a maxAge of hours doesn't translate into a
   * scan-every-many-minutes cadence that delays operator-visible failures.
   */
  const REAPER_INTERVAL_MAX_MS = 60_000
  /**
   * Floor on the reaper scan interval. Even when maxAge is small (e.g. 1s
   * for tests), don't scan faster than this — every scan walks all active
   * contexts and the cost is wasted when no entry is near expiry.
   */
  const REAPER_INTERVAL_MIN_MS = 250

  /**
   * Derive the per-instance scan interval. Scanning every `maxAge / 3` keeps
   * worst-case detection latency under ~1.33 × maxAge: a request that goes
   * stale right after a scan waits one full interval (maxAge/3) plus the
   * usual variance. Configurable via `staleRequestMaxAge` alone — no extra
   * knob, which means operators can't accidentally set them inconsistently.
   */
  function computeReaperIntervalMs(): number {
    const derived = Math.floor((state.staleRequestMaxAge * 1000) / 3)
    if (derived <= 0) return REAPER_INTERVAL_MAX_MS
    return Math.max(REAPER_INTERVAL_MIN_MS, Math.min(REAPER_INTERVAL_MAX_MS, derived))
  }

  let reaperTimer: ReturnType<typeof setInterval> | null = null

  /** Single reaper scan — force-fail contexts exceeding maxAge */
  function runReaperOnce() {
    const maxAgeMs = state.staleRequestMaxAge * 1000
    if (maxAgeMs <= 0) return // disabled

    for (const [id, ctx] of activeContexts) {
      if (ctx.durationMs > maxAgeMs) {
        consola.warn(
          `[context] Force-failing stale request ${id}`
            + ` (endpoint: ${ctx.endpoint}`
            + `, model: ${ctx.originalRequest?.model ?? "unknown"}`
            + `, stream: ${ctx.originalRequest?.stream ?? "?"}`
            + `, state: ${ctx.state}`
            + `, age: ${Math.round(ctx.durationMs / 1000)}s`
            + `, max: ${state.staleRequestMaxAge}s)`,
        )
        ctx.fail(ctx.originalRequest?.model ?? "unknown", new Error(`Request exceeded maximum age of ${state.staleRequestMaxAge}s (stale context reaper)`))
      }
    }
  }

  function startReaper() {
    if (reaperTimer) return // idempotent
    if (state.staleRequestMaxAge <= 0) return // explicitly disabled — no timer at all
    reaperTimer = setInterval(runReaperOnce, computeReaperIntervalMs())
  }

  function stopReaper() {
    if (reaperTimer) {
      clearInterval(reaperTimer)
      reaperTimer = null
    }
  }

  function emit(event: RequestContextEvent) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        // A consumer (history / TUI / metrics) bug must NOT take down the
        // request lifecycle — but it also must not be invisible. Include
        // endpoint and model so logs are actionable beyond a random request id.
        const endpoint = event.context.endpoint
        const model = event.context.originalRequest?.model
        consola.warn(
          `[context] listener threw for event "${event.type}" ` + `(request ${event.context.id}, endpoint ${endpoint}${model ? `, model ${model}` : ""}):`,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }

  /**
   * Build a RequestContextSnapshot enriched with the front-end activity
   * summary. Used by the lifecycle publishes below so WsSink can broadcast
   * `summarizeRequestContext`-shape payloads without re-deriving from a
   * live ctx. `feature_applied` / `stream_progress` / `attempt_*` events
   * intentionally omit the summary (they don't carry lifecycle deltas).
   */
  function snapshotWithSummary(context: RequestContext): RequestContextSnapshot {
    const billing = context.resolvedModel ? state.modelIndex.get(context.resolvedModel)?.billing : undefined
    return {
      id: context.id,
      endpoint: context.endpoint,
      ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
      ...(context.rawPath !== undefined && { rawPath: context.rawPath }),
      method: context.method,
      path: context.path,
      ...(context.clientModel !== null && { clientModel: context.clientModel }),
      ...(context.resolvedModel !== null && { resolvedModel: context.resolvedModel }),
      state: context.state,
      startTime: context.startTime,
      queueWaitMs: context.queueWaitMs,
      ...(context.requestBodySize !== undefined && { requestBodySize: context.requestBodySize }),
      ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
      summary: summarizeRequestContext(context),
    }
  }

  function handleContextEvent(rawEvent: RequestContextEventData) {
    const { type, context } = rawEvent

    switch (type) {
      case "state_changed": {
        if (rawEvent.previousState) {
          emit({
            type: "state_changed",
            context,
            previousState: rawEvent.previousState,
            meta: rawEvent.meta,
          })
          // Bus: WsSink picks this up and broadcasts to the front-end.
          publisher?.publish({
            kind: "request.state_changed",
            ctx: snapshotWithSummary(context),
            previousState: rawEvent.previousState,
            ...(rawEvent.meta !== undefined && { meta: rawEvent.meta }),
          })
        }
        break
      }
      case "updated": {
        if (rawEvent.field) {
          emit({
            type: "updated",
            context,
            field: rawEvent.field,
          })
          // HistorySink consumes this synchronously to mirror the legacy
          // `handleHistoryEvent` "updated" branch (originalRequest insert,
          // attempts/queueWaitMs/pipelineInfo/warningMessages updates).
          // See events.ts `request.context_updated` doc — synchronous-only,
          // contextRef must not be retained.
          publisher?.publish({
            kind: "request.context_updated",
            ctx: snapshotWithSummary(context),
            field: rawEvent.field,
            contextRef: context,
          })
        }
        break
      }
      case "completed": {
        if (rawEvent.entry) {
          emit({
            type: "completed",
            context,
            entry: rawEvent.entry,
          })
          // Bus: HistorySink persists, TelemetrySink records success,
          // WsSink broadcasts the lifecycle change.
          publisher?.publish({
            kind: "request.completed",
            ctx: snapshotWithSummary(context),
            entry: rawEvent.entry,
          })
        }
        activeContexts.delete(context.id)
        break
      }
      case "failed": {
        if (rawEvent.entry) {
          emit({
            type: "failed",
            context,
            entry: rawEvent.entry,
          })
          publisher?.publish({
            kind: "request.failed",
            ctx: snapshotWithSummary(context),
            entry: rawEvent.entry,
            error: rawEvent.entry.outboundResponse?.error ?? "Unknown error",
            ...(rawEvent.entry.outboundResponse?.status !== undefined && { statusCode: rawEvent.entry.outboundResponse.status }),
          })
        }
        activeContexts.delete(context.id)
        break
      }
      case "aborted": {
        if (rawEvent.entry) {
          // Deliberately NOT recorded into request-telemetry: a client
          // disconnect is not a verdict on the model/upstream (it neither
          // succeeded nor failed on the service's account), so counting it
          // would skew the per-model success rate. TelemetrySink filters
          // these out at subscribe time.
          emit({
            type: "aborted",
            context,
            entry: rawEvent.entry,
          })
          publisher?.publish({
            kind: "request.aborted",
            ctx: snapshotWithSummary(context),
            entry: rawEvent.entry,
          })
        }
        activeContexts.delete(context.id)
        break
      }
      default: {
        break
      }
    }
  }

  return {
    create(opts) {
      const ctx = createRequestContext({
        endpoint: opts.endpoint,
        sessionId: opts.sessionId,
        rawPath: opts.rawPath,
        method: opts.method,
        path: opts.path,
        requestBodySize: opts.requestBodySize,
        onEvent: handleContextEvent,
        publisher,
      })
      recordAcceptedRequest(ctx.startTime)
      activeContexts.set(ctx.id, ctx)
      emit({ type: "created", context: ctx })
      publisher?.publish({ kind: "request.created", ctx: snapshotWithSummary(ctx) })
      return ctx
    },

    get(id) {
      return activeContexts.get(id)
    },

    getAll() {
      return Array.from(activeContexts.values())
    },

    get activeCount() {
      return activeContexts.size
    },

    on(_event: "change", listener: (event: RequestContextEvent) => void) {
      listeners.add(listener)
    },

    off(_event: "change", listener: (event: RequestContextEvent) => void) {
      listeners.delete(listener)
    },

    startReaper,
    stopReaper,
    _runReaperOnce: runReaperOnce,
  }
}
