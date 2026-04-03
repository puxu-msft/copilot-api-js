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

import { state } from "~/lib/state"

import { notifyActiveRequestChanged } from "~/lib/ws"
import { recordAcceptedRequest, recordSettledRequest } from "~/lib/request-telemetry"

import type { HistoryEntryData, RequestContext, RequestContextEventData, RequestState } from "./request"

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

  const REAPER_INTERVAL_MS = 60_000
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
        ctx.fail(
          ctx.originalRequest?.model ?? "unknown",
          new Error(`Request exceeded maximum age of ${state.staleRequestMaxAge}s (stale context reaper)`),
        )
      }
    }
  }

  function startReaper() {
    if (reaperTimer) return // idempotent
    reaperTimer = setInterval(runReaperOnce, REAPER_INTERVAL_MS)
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
      } catch {
        // Swallow listener errors
      }
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
          recordSettledRequest(rawEvent.entry.response?.model ?? rawEvent.entry.request.model ?? "unknown", {
            startedAt: rawEvent.entry.startedAt,
            endedAt: rawEvent.entry.endedAt,
            success: rawEvent.entry.response?.success ?? true,
            usage: rawEvent.entry.response?.usage,
          })
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
          recordSettledRequest(rawEvent.entry.response?.model ?? rawEvent.entry.request.model ?? "unknown", {
            startedAt: rawEvent.entry.startedAt,
            endedAt: rawEvent.entry.endedAt,
            success: rawEvent.entry.response?.success ?? false,
            usage: rawEvent.entry.response?.usage,
          })
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
