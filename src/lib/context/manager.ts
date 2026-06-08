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

import {
  //
  recordAcceptedRequest,
  recordSettledRequest,
} from "~/lib/request-telemetry"
import { state } from "~/lib/state"
import { notifyActiveRequestChanged } from "~/lib/ws"

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

// ─── Manager Interface ───

export interface RequestContextManager {
  /** Create and register a new active request context */
  create(opts: { endpoint: EndpointType; sessionId?: string; tuiLogId?: string; rawPath?: string }): RequestContext

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

export function initRequestContextManager(): RequestContextManager {
  _manager = createRequestContextManager()
  return _manager
}

export function getRequestContextManager(): RequestContextManager {
  if (!_manager) throw new Error("RequestContextManager not initialized — call initRequestContextManager() first")
  return _manager
}

export function resetRequestContextManagerForTests(): RequestContextManager {
  _manager?.stopReaper()
  _manager = createRequestContextManager()
  return _manager
}

// ─── Factory ───

export function createRequestContextManager(): RequestContextManager {
  const activeContexts = new Map<string, RequestContext>()
  const listeners = new Set<(event: RequestContextEvent) => void>()

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
   * Mirror a settled history entry into request-telemetry. Used by both the
   * "completed" and "failed" paths; defaultSuccess flips the assumed success
   * value when the entry's `response.success` is missing (completed defaults
   * to true, failed defaults to false).
   */
  function recordSettledFromEntry(entry: HistoryEntryData, defaultSuccess: boolean): void {
    recordSettledRequest(entry.response?.model ?? entry.request.model ?? "unknown", {
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      success: entry.response?.success ?? defaultSuccess,
      usage: entry.response?.usage,
    })
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
          notifyActiveRequestChanged({
            action: "state_changed",
            request: summarizeRequestContext(context),
            activeCount: activeContexts.size,
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
        }
        break
      }
      case "completed": {
        if (rawEvent.entry) {
          recordSettledFromEntry(rawEvent.entry, true)
          emit({
            type: "completed",
            context,
            entry: rawEvent.entry,
          })
        }
        activeContexts.delete(context.id)
        notifyActiveRequestChanged({
          action: "completed",
          requestId: context.id,
          activeCount: activeContexts.size,
        })
        break
      }
      case "failed": {
        if (rawEvent.entry) {
          recordSettledFromEntry(rawEvent.entry, false)
          emit({
            type: "failed",
            context,
            entry: rawEvent.entry,
          })
        }
        activeContexts.delete(context.id)
        notifyActiveRequestChanged({
          action: "failed",
          requestId: context.id,
          activeCount: activeContexts.size,
        })
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
        tuiLogId: opts.tuiLogId,
        rawPath: opts.rawPath,
        onEvent: handleContextEvent,
      })
      recordAcceptedRequest(ctx.startTime)
      activeContexts.set(ctx.id, ctx)
      emit({ type: "created", context: ctx })
      notifyActiveRequestChanged({
        action: "created",
        request: summarizeRequestContext(ctx),
        activeCount: activeContexts.size,
      })
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
