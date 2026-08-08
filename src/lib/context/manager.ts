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

import { peekTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"
import { consola } from "consola"

import type { EndpointType } from "~/lib/history/store"
import type { HistoryReservation } from "~/lib/history/worker/admission"
import type {
  //
  ObservabilityEvent,
  ScopedPublisher,
} from "~/lib/observability"

import { REQUEST_DEADLINE_CANCEL_REASON } from "~/lib/error/cancellation-reason"
import { isHistoryPersistenceReservation } from "~/lib/history/worker/http-admission"
import { getHistoryAdmissionController } from "~/lib/history/worker/registry"
import { recordReaperTick } from "~/lib/observability/reaper-diagnostics"
import { state } from "~/lib/state"

import type {
  //
  ModelOperationRecord,
  OperationKind,
} from "./model-operation-record"
import type {
  //
  InboundQuery,
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
    agentId?: string
    rawPath?: string
    /**
     * HTTP method of the inbound request. Stored on RequestContext.method
     * for sinks to render. Default "UNKNOWN" if omitted.
     */
    method?: string
    /** Inbound URL path. Default "/" if omitted. */
    path?: string
    /** Client inbound query string + filtered upstream form (codec.parse forwards it). */
    query?: InboundQuery
    /** Inbound Content-Length header value, if present. */
    requestBodySize?: number
    historyReservation?: HistoryReservation
    operationIdentity?: {
      kind: OperationKind
      connectionId?: string
      responseCreateId?: string
      previousResponseId?: string | null
    }
  }): RequestContext

  /** Get an active request by ID */
  get(id: string): RequestContext | undefined

  /** Get all active requests (for history UI real-time view) */
  getAll(): Array<RequestContext>

  /** Number of active requests */
  readonly activeCount: number

  /**
   * OPERATION/finalization registry — a ctx stays tracked until its operation body quiesces AND
   * its generation finalizer publishes canonical observability, not merely until logical settle.
   * Serves shutdown drain so orphan settle-before work and pending immutable seals are both waited on.
   */
  getTrackedOperations(): Array<RequestContext>
  readonly trackedOperationCount: number
  /** Drain every generation finalizer and surface any canonical-finalization rejection. */
  drainModelOperationFinalizations(): Promise<void>

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
  /**
   * Whether to arm a per-request hard-deadline timer (`state.requestDeadline`) on `create()`.
   * Default true. The capturing manager (dry-run inspection) passes false so an inspected ctx
   * never leaves a dangling deadline timer / force-fails a throwaway context (RFC C4b inspection
   * exemption).
   */
  armDeadlineTimers?: boolean
}

export function initRequestContextManager(options?: RequestContextManagerOptions): RequestContextManager {
  _manager = createRequestContextManager(options)
  return _manager
}

export function getRequestContextManager(): RequestContextManager {
  if (!_manager) throw new Error("RequestContextManager not initialized — call initRequestContextManager() first")
  return _manager
}

/** Optional lifecycle lookup for shutdown harnesses/processes that never initialize request serving. */
export function peekRequestContextManager(): RequestContextManager | null {
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
  _manager = createRequestContextManager({ publisher, armDeadlineTimers: false })
  try {
    return { result: fn(), events }
  } finally {
    _manager = saved
  }
}

/**
 * Async counterpart of {@link withCapturingManager}: `fn` is `await`ed **inside** the capture
 * window, so a caller whose work is asynchronous (e.g. the driver's `inspectRequest`, which now
 * runs an async S1b `translateInbound` stage — RFC 2026-07-14 §3 / review MEDIUM-1) keeps its
 * `request.*` events captured for the whole duration. The sync {@link withCapturingManager}
 * restores the manager the moment `fn()` returns a Promise — closing the window before the async
 * body runs — which would let the async side effects escape to the real bus. Use THIS whenever
 * `fn` returns a Promise; keep the sync one for sync `fn`s (e.g. `codec.parse`).
 */
export async function withCapturingManagerAsync<T>(fn: () => Promise<T>): Promise<{ result: T; events: Array<CapturedRequestEvent> }> {
  const saved = _manager
  const events: Array<CapturedRequestEvent> = []
  const publisher = {
    publish: (event: CapturedRequestEvent) => void events.push(event),
    publishAndFlush: (event: CapturedRequestEvent) => {
      events.push(event)
      return Promise.resolve({ delivered: true } as never)
    },
  } as unknown as ScopedPublisher<"request">
  _manager = createRequestContextManager({ publisher, armDeadlineTimers: false })
  try {
    return { result: await fn(), events }
  } finally {
    _manager = saved
  }
}

// ─── Factory ───

/**
 * Cap on the reaper scan interval: a scan misses stale work for at most
 * `interval` ms, so clamp so a maxAge of hours doesn't mean a scan-every-many-
 * minutes cadence that delays operator-visible failures.
 */
export const REAPER_INTERVAL_MAX_MS = 60_000
/**
 * Floor on the reaper scan interval: every scan walks all active contexts, so
 * don't scan faster than this even when maxAge is tiny (e.g. 1s in tests).
 */
export const REAPER_INTERVAL_MIN_MS = 250

/**
 * Derive the reaper scan interval (ms) from `staleRequestMaxAge` (seconds).
 * Scanning every `maxAge / 3` keeps worst-case detection latency under ~1.33 ×
 * maxAge, clamped to [MIN, MAX]; `maxAge ≤ 0` (disabled) returns MAX. Derived
 * from `staleRequestMaxAge` alone — no extra knob to set inconsistently.
 *
 * Exported as a pure, parameterized function so the /3 formula and both clamp
 * edges get direct boundary regression coverage (DI-7).
 */
export function computeReaperIntervalMs(staleRequestMaxAgeSec: number): number {
  const derived = Math.floor((staleRequestMaxAgeSec * 1000) / 3)
  if (derived <= 0) return REAPER_INTERVAL_MAX_MS
  return Math.max(REAPER_INTERVAL_MIN_MS, Math.min(REAPER_INTERVAL_MAX_MS, derived))
}

export function createRequestContextManager(options?: RequestContextManagerOptions): RequestContextManager {
  const activeContexts = new Map<string, RequestContext>()
  // Operation/finalization registry: populated alongside activeContexts, sealed at logical settle,
  // and retained until the unique generation finalizer has awaited scope quiescence and published
  // canonical observability. It therefore covers both operation-body orphan work and immutable seal.
  const operationScopes = new Map<string, RequestContext>()
  const pendingModelOperationFinalizations = new Set<Promise<ModelOperationRecord>>()
  const modelOperationFinalizationFailures: Array<unknown> = []
  const publisher = options?.publisher
  const armDeadlineTimers = options?.armDeadlineTimers ?? true
  // Per-request hard-deadline timers (RFC C4b). Unlike the periodic reaper scan (which fires
  // LATE — RC2), each request gets a precise monotonic timer armed at create() for
  // `state.requestDeadline` seconds. On fire it applies the SAME cancel+settle as the reaper
  // (reapInFlight → fail), but ON TIME regardless of scan cadence / config reload / suspend
  // recovery jitter. Cleared on settle. 0 = disabled (byte-identical to the reaper-only path).
  const deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function clearDeadlineTimer(id: string): void {
    const t = deadlineTimers.get(id)
    if (t) {
      clearTimeout(t)
      deadlineTimers.delete(id)
    }
  }

  // ─── Stale Request Reaper ───

  let reaperTimer: ReturnType<typeof setInterval> | null = null
  // Reaper tick timing (RC2 diagnostics — see reaper-diagnostics.ts). Frozen interval is
  // captured at startReaper; last-tick wall + monotonic clocks let us distinguish a
  // config-reload cadence mismatch / process-or-WSL suspend from event-loop blocking.
  let reaperFrozenIntervalMs = 0
  let lastTickWallMs: number | undefined
  let lastTickMonoMs: number | undefined

  /** Single reaper scan — force-fail contexts exceeding maxAge */
  function runReaperOnce() {
    // Tick diagnostics FIRST (records every scan, incl. disabled/empty ones, so drift is
    // observable regardless of whether anything was reaped). Pure observation — no behavior change.
    const actualAt = Date.now()
    const nowMono = performance.now()
    const scheduledAt = lastTickWallMs !== undefined ? lastTickWallMs + reaperFrozenIntervalMs : actualAt
    const monotonicGapMs = lastTickMonoMs !== undefined ? nowMono - lastTickMonoMs : reaperFrozenIntervalMs
    const wallGapMs = lastTickWallMs !== undefined ? actualAt - lastTickWallMs : reaperFrozenIntervalMs
    lastTickWallMs = actualAt
    lastTickMonoMs = nowMono
    const scanStartMono = nowMono

    const maxAgeMs = state.staleRequestMaxAge * 1000
    if (maxAgeMs <= 0) {
      recordReaperTick({
        scheduledAt,
        actualAt,
        scanDurationMs: performance.now() - scanStartMono,
        activeCount: activeContexts.size,
        liveMaxAgeSec: state.staleRequestMaxAge,
        frozenIntervalMs: reaperFrozenIntervalMs,
        monotonicGapMs,
        wallGapMs,
      })
      return // disabled
    }

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
        ctx.fail(
          ctx.originalRequest?.model ?? "unknown",
          new Error(`Request exceeded maximum age of ${state.staleRequestMaxAge}s (stale context reaper)`),
          undefined,
          { attribution: { category: "reaper", code: "stale-context-reaper" } },
        )
      }
    }
    recordReaperTick({
      scheduledAt,
      actualAt,
      scanDurationMs: performance.now() - scanStartMono,
      activeCount: activeContexts.size,
      liveMaxAgeSec: state.staleRequestMaxAge,
      frozenIntervalMs: reaperFrozenIntervalMs,
      monotonicGapMs,
      wallGapMs,
    })
  }

  function startReaper() {
    if (reaperTimer) return // idempotent
    if (state.staleRequestMaxAge <= 0) return // explicitly disabled — no timer at all
    reaperFrozenIntervalMs = computeReaperIntervalMs(state.staleRequestMaxAge)
    lastTickWallMs = undefined
    lastTickMonoMs = undefined
    reaperTimer = setInterval(runReaperOnce, reaperFrozenIntervalMs)
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
        agentId: opts.agentId,
        rawPath: opts.rawPath,
        method: opts.method,
        path: opts.path,
        query: opts.query,
        requestBodySize: opts.requestBodySize,
        historyReservation: opts.historyReservation,
        operationIdentity: opts.operationIdentity,
        // Pure resource-management hook — remove the context from the active
        // map when it settles. Lifecycle events reach the bus via the context's
        // own `publisher` (the single event channel since P0.3), not via a
        // manager bridge.
        onSettled: (id) => {
          clearDeadlineTimer(id)
          activeContexts.delete(id)
          // Logical settle seals the operation scope. The context remains in the shutdown
          // registry through BOTH operation quiescence and the generation finalizer, whose join
          // waits for delivery notification and canonical publish. This is intentionally separate
          // from the post-terminal FinalizationCoordinator.
          const tracked = operationScopes.get(id)
          if (tracked) {
            tracked.sealOperationScope()
            const finalization = tracked.whenModelOperationFinalized()
            pendingModelOperationFinalizations.add(finalization)
            void finalization.then(
              () => {
                pendingModelOperationFinalizations.delete(finalization)
                operationScopes.delete(id)
              },
              (error: unknown) => {
                pendingModelOperationFinalizations.delete(finalization)
                operationScopes.delete(id)
                modelOperationFinalizationFailures.push(error)
                if (isHistoryPersistenceReservation(opts.historyReservation)) {
                  try {
                    getHistoryAdmissionController().failBeforeTerminal(id, error)
                  } catch (releaseError) {
                    consola.error(`[context] Failed to release History reservation ${id}:`, releaseError)
                  }
                }
                consola.error(`[context] Generation finalization failed for ${id}:`, error)
              },
            )
          }
        },
        publisher,
      })
      peekTelemetryRuntime()?.recordAccepted(ctx.startTime)
      activeContexts.set(ctx.id, ctx)
      operationScopes.set(ctx.id, ctx)
      // Arm the hard-deadline timer (C4b). It enters the unified cancellation provenance first
      // (`cancelReason=request_deadline`, operationSignal abort), then records the timeout terminal.
      // This fires ON TIME via a per-request timer (bypasses RC2's late scan); `unref` prevents it
      // from keeping the process alive. fail records the terminal outcome (settled-guard dedups).
      if (armDeadlineTimers && state.requestDeadline > 0) {
        const timer = setTimeout(() => {
          deadlineTimers.delete(ctx.id)
          if (ctx.settled) return
          consola.warn(
            `[context] Request ${ctx.id} exceeded hard deadline ${state.requestDeadline}s (model: ${ctx.originalRequest?.model ?? "unknown"}, state: ${ctx.state}) — cancelling`,
          )
          ctx.cancel(REQUEST_DEADLINE_CANCEL_REASON)
          ctx.fail(
            ctx.originalRequest?.model ?? "unknown",
            new Error(`Request exceeded hard deadline of ${state.requestDeadline}s (request_deadline)`),
            undefined,
            { attribution: { category: "timeout", code: "request_deadline" } },
          )
        }, state.requestDeadline * 1000)
        ;(timer as unknown as { unref?: () => void }).unref?.()
        deadlineTimers.set(ctx.id, timer)
      }
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

    getTrackedOperations() {
      return Array.from(operationScopes.values())
    },

    get trackedOperationCount() {
      return operationScopes.size
    },

    async drainModelOperationFinalizations() {
      while (pendingModelOperationFinalizations.size > 0) {
        await Promise.allSettled(pendingModelOperationFinalizations)
      }
      if (modelOperationFinalizationFailures.length > 0) {
        const failures = modelOperationFinalizationFailures.splice(0)
        throw new AggregateError(failures, "Generation finalization failed")
      }
    },

    startReaper,
    stopReaper,
    _runReaperOnce: runReaperOnce,
  }
}
