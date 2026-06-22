/**
 * RequestContextManager — Active request management
 *
 * Manages all in-flight RequestContext instances. The "active layer"
 * complementing the history store (persistence layer). It tracks the live
 * contexts and publishes `request.created` on the bus; every other lifecycle
 * signal is published by the context itself (the bus is the single event
 * channel since P0.3).
 *
 * Data flow:
 *   Handler creates RequestContext → manager.create() registers it + publishes
 *     `request.created` on the bus
 *   → pipeline processes request, calls ctx.transition()/setPipelineInfo()/etc,
 *     each of which publishes a `request.*` event on the bus directly
 *   → sinks (HistorySink / WsSink / TelemetrySink / ConsoleSink) consume the bus
 *   → ctx.complete()/fail()/abort() publishes the terminal event, then invokes
 *     the manager's `onSettled` hook to remove the context from the active map
 */

import { consola } from "consola"

import type { EndpointType } from "~/lib/history/store"
import type {
  //
  ObservabilityEvent,
  ScopedPublisher,
} from "~/lib/observability"

import { recordAcceptedRequest } from "~/lib/request-telemetry"
import { state } from "~/lib/state"

import type {
  //
  RequestContext,
} from "./request"

import { snapshotWithSummary } from "./activity-summary"
import { createRequestContext } from "./request"

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
   * through to every `createRequestContext` call so the context's emit methods
   * (`setResolvedModel`, `transition`, `complete`, …) publish to the bus, and
   * used directly for the `request.created` publish. Optional only in unit
   * tests that don't assert on the bus; wired to `bus.scope("request")` in
   * start.ts for the real runtime.
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

/** A captured `request.*` ObservabilityEvent (from {@link withCapturingManager}). */
export type CapturedRequestEvent = Extract<ObservabilityEvent, { kind: `request.${string}` }>

/**
 * Run `fn` with the module-global manager temporarily swapped for a fresh one whose `request.*`
 * events are captured locally (NOT published to the real bus → no History/in-flight/WS pollution).
 * For dry-run / inspection: `codec.parse` builds its ctx via this captured manager, so the request
 * never surfaces as a real one. Returns `fn`'s result + the captured events (feature/pipeline-info
 * side-channel diagnostics).
 *
 * Side-effect-free isolation (RFC §11): the temp manager's reaper is NEVER started
 * (`createRequestContextManager` doesn't auto-start it), so there's no timer to leak; the saved
 * manager is restored by reference WITHOUT `stopReaper()` (unlike `resetRequestContextManagerForTests`,
 * which would kill the production reaper). Caller must serialize concurrent dry-runs — the swap is a
 * process-global window; concurrent REAL requests during it route their `request.*` events into the
 * capture array (lost from the bus), so don't run during heavy traffic.
 */
export function withCapturingManager<T>(fn: () => T): { result: T; events: Array<CapturedRequestEvent> } {
  const saved = _manager
  const events: Array<CapturedRequestEvent> = []
  const publisher = {
    publish: (event: CapturedRequestEvent) => void events.push(event),
    publishAndFlush: (event: CapturedRequestEvent) => {
      events.push(event)
      return Promise.resolve({ delivered: true } as never)
    },
  } as unknown as ScopedPublisher<"request">
  _manager = createRequestContextManager({ publisher })
  try {
    return { result: fn(), events }
  } finally {
    _manager = saved
  }
}

// ─── Factory ───

export function createRequestContextManager(options?: RequestContextManagerOptions): RequestContextManager {
  const activeContexts = new Map<string, RequestContext>()
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
        // Give the reaper teeth (缺陷④): cancel the in-flight upstream fetch / stream
        // via the lifecycle signal — the transport folds it into the fetch (cancels a
        // pre-response header-wait) and the stream guard (a mid-stream reap reaches a
        // live client as a `reaper-cancel` → `stream-error` → error frame). `fail()`
        // stays as the terminal-state record + safety net for the no-active-consumer
        // edge; the `settled` guard dedups with the handler's own settle.
        ctx.reapInFlight()
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

  return {
    create(opts) {
      const ctx = createRequestContext({
        endpoint: opts.endpoint,
        sessionId: opts.sessionId,
        rawPath: opts.rawPath,
        method: opts.method,
        path: opts.path,
        requestBodySize: opts.requestBodySize,
        // Pure resource-management hook — remove the context from the active
        // map when it settles. Lifecycle events reach the bus via the context's
        // own `publisher` (the single event channel since P0.3), not via a
        // manager bridge.
        onSettled: (id) => {
          activeContexts.delete(id)
        },
        publisher,
      })
      recordAcceptedRequest(ctx.startTime)
      activeContexts.set(ctx.id, ctx)
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

    startReaper,
    stopReaper,
    _runReaperOnce: runReaperOnce,
  }
}
