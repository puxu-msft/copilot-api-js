/**
 * RequestContextManager — Active request management
 *
 * Manages all in-flight RequestContext instances. Publishes events for
 * WebSocket push and history persistence. The "active layer" complementing
 * the history store (persistence layer).
 *
 * Data flow:
 *   Handler creates RequestContext → manager.create() registers + emits "created"
 *   → pipeline processes request, calls ctx.transition()/setRewrites()/etc
 *   → each change → manager emits events
 *   → ws receives events → pushes to browser
 *   → ctx.complete()/fail() → ctx.toHistoryEntry() → store.insert()
 *   → manager emits "completed"/"failed" → removes active context
 */

import type { HistoryEntryData, RequestContext, RequestContextEventData, RequestState } from "./request"

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
  create(opts: { endpoint: "anthropic" | "openai"; trackingId?: string }): RequestContext

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
}

// ─── Implementation ───

export function createRequestContextManager(): RequestContextManager {
  const activeContexts = new Map<string, RequestContext>()
  const listeners = new Set<(event: RequestContextEvent) => void>()

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
          emit({
            type: "completed",
            context,
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
        trackingId: opts.trackingId,
        onEvent: handleContextEvent,
      })
      activeContexts.set(ctx.id, ctx)
      emit({ type: "created", context: ctx })
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
  }
}
