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
import type {
  //
  ObservabilityEvent,
  ScopedPublisher,
} from "~/lib/observability"

import { REQUEST_DEADLINE_CANCEL_REASON } from "~/lib/error/cancellation-reason"
import { recordReaperTick } from "~/lib/observability/reaper-diagnostics"
import { state } from "~/lib/state"

import type {
  //
  ModelOperationRecord,
  OperationKind,
} from "./model-operation-record"
import type { OperationBlocker } from "./operation-lifecycle"
import type {
  //
  InboundQuery,
  RequestContext,
} from "./request"

import { snapshotWithSummary } from "./activity-summary"
import { createRequestContext } from "./request"

/** Every {@link OperationBlocker} except `"none"` — a tracked operation is never retained once its blocker is `"none"` (the release primitive removes it synchronously at that point). */
export type TrackedOperationBlocker = Exclude<OperationBlocker, "none">

/** Immediate aggregation over the tracked-operation registry — never a parallel running counter (Task 4 §Step 4). */
export interface TrackedOperationsSnapshot {
  readonly count: number
  readonly byBlocker: Readonly<Record<TrackedOperationBlocker, number>>
  readonly oldestAgeMs: number
}

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
  /**
   * Immediate aggregation over the tracked-operation registry (recomputed on every call — never a
   * parallel running counter, so it can never drift from `getTrackedOperations()`). `now` defaults
   * to `Date.now()`; tests pass a fixed value for deterministic `oldestAgeMs` assertions.
   */
  getTrackedOperationsSnapshot(now?: number): TrackedOperationsSnapshot
  /** Drain every pending canonical finalizer and surface any registered delivery/canonical lifecycle failure. */
  drainLifecycleFailures(): Promise<void>

  /** Start periodic cleanup of stale active contexts */
  startReaper(): void

  /** Stop the reaper (for shutdown/cleanup) */
  stopReaper(): void

  /** Run a single reaper scan (exposed for testing) */
  _runReaperOnce(): void

  /**
   * TEST-ONLY: current size of the internal `lifecycleFailureBarrier` map. Exists so a test can
   * mechanically prove the barrier's storage is bounded by tracked-operation lifetime (evicted at
   * `releaseTrackedOperationIfTerminal`), not left to grow monotonically until someone happens to
   * call `drainLifecycleFailures()` — the review MAJOR finding on commit 3e418cdb. Production code
   * must never read this (it is not part of any product-facing contract).
   */
  _lifecycleFailureBarrierSize(): number
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
  // Process shutdown lifecycle failure barrier storage — dedup key is `${requestId}:${phase}`.
  // This IS the barrier `onLifecycleFailure` (passed to every `createRequestContext`) consults —
  // the frozen spec's authoritative meaning of `failureRegistered: true` is "the process shutdown
  // lifecycle failure barrier has synchronously taken ownership of this error", never a
  // context-local ledger (see plan Global Constraints + progress file "已作废路线").
  const lifecycleFailureBarrier = new Map<string, { error: unknown }>()
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

  /**
   * The single release primitive for `operationScopes` (Task 4 Step 3). Both the finalizer
   * resolve AND reject branches call this — never `operationScopes.delete` directly — so there is
   * exactly one place that decides whether a tracked operation may leave the registry. Reads the
   * ctx's OWN published lifecycle snapshot rather than assuming the caller's outcome implies
   * `blocker === "none"`: a rejected finalizer whose failure was NOT registered by the barrier
   * (`onLifecycleFailure` returned false/threw/absent) keeps `blocker === "canonical-finalization"`
   * — deleting it anyway would make the shutdown drain and `/api/status` silently stop reporting a
   * genuinely-unresolved failure (exactly the "false-green skip" the frozen spec forbids).
   *
   * THIS is also the ONLY place that evicts `lifecycleFailureBarrier` entries (review finding
   * blocker+major, commit 3e418cdb): by the time `blocker === "none"`, `failGenerationDelivery`
   * (delivery phase) and/or the canonical finalizer's catch (canonical phase) have ALREADY called
   * `registerLifecycleFailure` synchronously — a delivery failure locks `isDeliveryOutcomeLocked`
   * before the finalizer can even start, and a canonical failure is registered inside the finalizer's
   * own catch before it rejects — so any barrier entry for this id is guaranteed present here if it
   * exists. Evicting it into `modelOperationFinalizationFailures` (the ONLY queue
   * `drainLifecycleFailures()` reads) fixes BOTH defects with one mechanism:
   *   - blocker: a registered delivery failure alone (canonical succeeds) never rejects the
   *     finalizer promise, so the old reject-only push into `modelOperationFinalizationFailures`
   *     never saw it — `lifecycleFailureBarrier` was write-only. Eviction here means EVERY
   *     registered failure (delivery, canonical, or both) reaches the drain queue exactly once.
   *   - major: the barrier's storage lifetime is now bounded by each tracked operation's OWN
   *     lifetime (evicted the moment it leaves `operationScopes`), not by how often/whether anyone
   *     ever calls `drainLifecycleFailures()` (in production that's only at shutdown — this manager
   *     is a process-level singleton, so without release-time eviction the map would grow
   *     monotonically with every failed request for the life of the process).
   * The reject callback below no longer pushes the canonical error itself — doing so AND evicting
   * it here would double-count the SAME error in `modelOperationFinalizationFailures`.
   */
  function releaseTrackedOperationIfTerminal(id: string): void {
    const ctx = operationScopes.get(id)
    if (!ctx || ctx.operationLifecycle.blocker !== "none") return
    operationScopes.delete(id)
    for (const phase of ["delivery", "canonical"] as const) {
      const key = `${id}:${phase}`
      const entry = lifecycleFailureBarrier.get(key)
      if (entry !== undefined) {
        lifecycleFailureBarrier.delete(key)
        modelOperationFinalizationFailures.push(entry.error)
      }
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
            // Terminal outcome (resolve or reject) is handled ONLY here — the single release
            // primitive below, never inline in these two callbacks (Task 4 Step 3: "禁止在两条
            // promise callback 内直接 operationScopes.delete"). By the time either branch runs,
            // RequestContext has already published its terminal lifecycle state (delivery
            // finalized/failed + canonical completed/failed). A REGISTERED delivery and/or
            // canonical failure reaches `drainLifecycleFailures()` exclusively through
            // `releaseTrackedOperationIfTerminal`'s barrier eviction below (review fix for the
            // blocker+major on commit 3e418cdb) — NOT pushed again here — because:
            //   - a delivery-only failure (canonical still succeeds) never rejects this promise at
            //     all, so pushing only in the reject branch was write-only for that case (the
            //     blocker); the release-time eviction covers BOTH branches uniformly.
            //   - pushing `error` here in addition to the release-time eviction would double-count
            //     the SAME canonical failure when the barrier registered it (the common case).
            // An UNREGISTERED canonical rejection (onLifecycleFailure returned false/threw/absent —
            // production-unreachable through this manager's wiring, since a fresh id+phase always
            // registers on first call; see review finding C2) leaves `blocker` at
            // "canonical-finalization" forever, so release() is a no-op and the ctx stays visible
            // via `getTrackedOperationsSnapshot()`/shutdown drain instead of silently vanishing —
            // that is the intended "surface it, don't drop it" behavior for that gap, not a bug to
            // paper over here.
            void finalization.then(
              () => {
                pendingModelOperationFinalizations.delete(finalization)
                releaseTrackedOperationIfTerminal(id)
              },
              (error: unknown) => {
                pendingModelOperationFinalizations.delete(finalization)
                consola.error(`[context] Generation finalization failed for ${id}:`, error)
                releaseTrackedOperationIfTerminal(id)
              },
            )
          }
        },
        // Process shutdown lifecycle failure barrier — the ONLY synchronous registration entry
        // point for a delivery/canonical lifecycle failure (Task 4 Step 3). Dedupes on
        // `(requestId, phase, error identity)` so a repeated call for the SAME already-registered
        // error returns true (idempotent — a canonical catch racing a late delivery-failure retry
        // must not silently under-report), while a genuinely new error for an id/phase pair that
        // already holds a DIFFERENT error returns false (this barrier holds one error per phase,
        // by design — it is a presence gate, not a multi-error collector; `drainLifecycleFailures()`
        // is the durability drain for the finalizer promise, and is where multiple distinct
        // rejections across different requests actually accumulate).
        onLifecycleFailure: (requestId, failure) => {
          const key = `${requestId}:${failure.phase}`
          const existing = lifecycleFailureBarrier.get(key)
          if (existing !== undefined) return existing.error === failure.error
          lifecycleFailureBarrier.set(key, { error: failure.error })
          return true
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

    getTrackedOperationsSnapshot(now = Date.now()) {
      const byBlocker: Record<TrackedOperationBlocker, number> = {
        "request-running": 0,
        "operation-body": 0,
        "delivery-finalization": 0,
        "canonical-finalization": 0,
      }
      let oldestStartTime: number | undefined
      for (const ctx of operationScopes.values()) {
        const { blocker } = ctx.operationLifecycle
        // A tracked operation is NEVER retained with blocker "none" — `releaseTrackedOperationIfTerminal`
        // is the sole point that may delete from `operationScopes`, and it only leaves a ctx in place
        // when blocker !== "none". Seeing "none" here means that release contract was violated somewhere
        // (a stray direct `operationScopes.delete` bypass, or a new terminal path that forgot to route
        // through the release primitive) — surface it as a loud invariant violation rather than silently
        // folding it into the public aggregate (Task 4 Step 4: "证明 release 接缝漏执行，而不是把它计入公开聚合").
        if (blocker === "none") {
          throw new Error(`[context] invariant violation: tracked operation ${ctx.id} has blocker "none" (release primitive was bypassed)`)
        }
        byBlocker[blocker]++
        if (oldestStartTime === undefined || ctx.startTime < oldestStartTime) oldestStartTime = ctx.startTime
      }
      return Object.freeze({
        count: operationScopes.size,
        byBlocker: Object.freeze(byBlocker),
        oldestAgeMs: oldestStartTime === undefined ? 0 : now - oldestStartTime,
      })
    },

    async drainLifecycleFailures() {
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
    _lifecycleFailureBarrierSize: () => lifecycleFailureBarrier.size,
  }
}
