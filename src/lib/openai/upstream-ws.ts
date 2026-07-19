import consola from "consola"
import { randomUUID } from "node:crypto"

// `state` is read inside the singleton getter only; state.ts does not import
// back into upstream-ws*, so this is a safe top-level edge in the module
// graph. If a future change to state.ts introduces a cycle this import should
// be moved inside the getter via dynamic import.
import {
  //
  onUpstreamTransportChange,
  state,
} from "~/lib/state"

import type {
  //
  CreateUpstreamWsConnectionOptions,
  UpstreamWsConnection,
} from "./upstream-ws-connection"

import { createUpstreamWsConnection } from "./upstream-ws-connection"

const MAX_CONSECUTIVE_WS_FALLBACKS = 3
/**
 * Half-open recovery window: once temporarily disabled by consecutive fallbacks,
 * automatically allow another attempt after this many milliseconds. The window
 * arms at most twice in succession — once when the failure threshold is first
 * crossed, and once if the half-open probe (the next attempt after the window
 * elapses) also fails. After that, further `recordFallback` calls while still
 * in the disabled window do NOT extend it; the window expires naturally and a
 * fresh probe is allowed.
 */
const DISABLE_RECOVERY_WINDOW_MS = 5 * 60_000
/**
 * Soft cap on simultaneous upstream WS connections. When exceeded at create()
 * time, the oldest idle connection is evicted. Busy connections are never
 * touched, so the pool may temporarily exceed the cap under sustained load.
 */
const DEFAULT_MAX_CONNECTIONS = 32

/**
 * Idle-close deadline in milliseconds for a pooled (not-in-use) upstream WS
 * connection, read fresh from `state.pooledConnectionIdleTimeout` (seconds) on
 * every {@link createUpstreamWsManager}'s `create()` call — so a hot-reloaded
 * value applies to the NEXT connection immediately. P4 additionally reconciles
 * ALREADY-pooled connections via `rescheduleIdleTimeout` (out of P2's scope —
 * this function only affects newly created connections, per the global "new
 * knobs only affect new connections" constraint).
 */
export function getPooledConnectionIdleTimeoutMs(): number {
  return state.pooledConnectionIdleTimeout * 1000
}

let connectionFactory: (opts: CreateUpstreamWsConnectionOptions) => UpstreamWsConnection = createUpstreamWsConnection

interface WsBreakerEntry {
  consecutiveFallbacks: number
  disabledUntil: number
}

/** Per-model circuit-breaker snapshot row for /api/status (richest-data-flow). */
export interface WsBreakerSnapshotRow {
  model: string
  consecutiveFallbacks: number
  temporarilyDisabled: boolean
  disabledUntilMs: number
}

/** Per-connection status row for /api/status (richest-data-flow). */
export interface UpstreamWsStatusRow {
  key: string
  model: string
  state: "connecting" | "busy" | "idle"
  generation: number
}

/**
 * Observability for `reconcileForConfigChange()` (P4 major fix, spec §4 D7
 * HIGH-3) — mirrors h2's `getH2ReconcileStatus()` shape verbatim so /api/status
 * (P5) can render both transports' reconcile health the same way. `state`
 * here is reconcile-run status ("idle" = not currently running / last run
 * succeeded, "running" = mid-call, "failed" = last call threw and was
 * caught), a DIFFERENT axis from `UpstreamWsStatusRow.state` (per-connection
 * connecting/busy/idle) — same field name, unrelated meaning, exactly as h2's
 * own `H2SessionStatusRow.lifecycle` vs `getH2ReconcileStatus().state` are
 * two separate axes under different field names in that module; kept as
 * `state` here (not renamed) because it is a 1:1 mirror of
 * `getH2ReconcileStatus()`'s own field name, and the two interfaces
 * (`UpstreamWsStatusRow` vs `UpstreamWsReconcileStatus`) are never mixed at
 * a single call site.
 */
export interface UpstreamWsReconcileStatus {
  state: "idle" | "running" | "failed"
  lastCompletedGeneration: number
  lastError: string | null
}

export interface UpstreamWsManager {
  findReusable(opts: { previousResponseId?: string; conversationId?: string; model: string }): UpstreamWsConnection | undefined
  create(opts: { headers: Record<string, string>; model: string; conversationId?: string }): Promise<UpstreamWsConnection>
  stopNew(): void
  closeAll(): void
  resetRuntimeState(): void
  recordSuccessfulStart(key: string): void
  recordFallback(key: string): void
  readonly activeCount: number
  consecutiveFallbacks(key: string): number
  temporarilyDisabled(key: string): boolean
  /** Unix epoch ms when the half-open recovery window expires for `key` (0 when not disabled). */
  disabledUntilMs(key: string): number
  /** Per-model breaker rows (only models with a live entry appear — clean models are omitted). */
  breakerSnapshot(): Array<WsBreakerSnapshotRow>
  /** Hot-reload (P4): reschedule every pooled connection's idle-close deadline to `newIdleTimeoutMs`, bump this manager's generation counter, and evict excess IDLE connections down to the (possibly shrunk) soft-max cap. Busy connections are left alone — they converge via existing mechanisms (see Architecture). */
  reconcileForConfigChange(newIdleTimeoutMs: number): void
  /** Per-connection status rows for /api/status (P5). */
  statusSnapshot(): ReadonlyArray<UpstreamWsStatusRow>
  /** Observability for the LAST `reconcileForConfigChange()` call — mirrors h2's `getH2ReconcileStatus()` (P5). */
  reconcileStatus(): UpstreamWsReconcileStatus
  readonly stopped: boolean
}

export interface CreateUpstreamWsManagerOptions {
  /**
   * Soft cap on concurrent upstream WS connections. Accepts a static number or
   * a getter for runtime-configurable values (e.g. read from state on each
   * eviction so config hot-reload takes effect without recreating the manager).
   * 0 means unlimited. Defaults to DEFAULT_MAX_CONNECTIONS.
   */
  maxConnections?: number | (() => number)
}

export function createUpstreamWsManager(opts: CreateUpstreamWsManagerOptions = {}): UpstreamWsManager {
  const getMaxConnections = (): number => {
    const raw = typeof opts.maxConnections === "function" ? opts.maxConnections() : opts.maxConnections
    if (raw === undefined) return DEFAULT_MAX_CONNECTIONS
    return raw
  }
  const connections = new Map<string, UpstreamWsConnection>()
  const lastUsedAt = new Map<string, number>()
  /** Generation stamped at create() time; bumped on every reconcileForConfigChange() call. Instance-scoped (per-manager), unlike h2's module-global currentGeneration — each manager owns its own connection pool. */
  const connectionGeneration = new Map<string, number>()
  let currentGeneration = 0
  let reconcileRunState: "idle" | "running" | "failed" = "idle"
  let lastCompletedReconcileGeneration = 0
  let lastReconcileError: string | null = null
  let stopped = false
  // Per-model circuit breaker: `consecutiveFallbacks`/`disabledUntil` keyed by
  // the bare model string (same key space as the connection pool's
  // `connection.model` reuse-match). A missing entry = clean (0 fallbacks, not
  // disabled) — read paths return the clean default without creating an entry;
  // `recordSuccessfulStart` deletes the entry (lazy GC; only failing/disabled
  // models occupy a slot). This isolates a chronically-failing model (gpt-5.5's
  // WS pre-first-event idle-close) from disabling the WS path for good models.
  const breaker = new Map<string, WsBreakerEntry>()

  const isDisabled = (key: string): boolean => {
    const entry = breaker.get(key)
    return entry !== undefined && Date.now() < entry.disabledUntil
  }

  const touch = (key: string) => {
    lastUsedAt.set(key, Date.now())
  }

  const evictOneIdleIfNeeded = () => {
    const cap = getMaxConnections()
    if (cap <= 0) return // 0 disables the cap entirely
    if (connections.size < cap) return
    let victimKey: string | null = null
    let victimAge = Infinity
    for (const [key, connection] of connections) {
      // Skip not-yet-connected placeholders. They occupy a slot but have no
      // socket to close — picking them as eviction victims would silently leak
      // pool size (connection.close() would no-op and onClose would never fire).
      // Their concurrent connect() will resolve in due time and they'll become
      // eligible for the next round of eviction once truly idle.
      if (!connection.isOpen) continue
      if (connection.isBusy) continue
      const age = lastUsedAt.get(key) ?? 0
      if (age < victimAge) {
        victimAge = age
        victimKey = key
      }
    }
    if (victimKey === null) {
      // All connections are busy — pool cap will be temporarily exceeded.
      // We do not refuse the request (refusal would bubble into the fallback
      // counter and could disable WS under sustained load); instead we warn so
      // operators can detect chronic over-provisioning.
      consola.warn(
        `[upstream-ws] Pool cap (${cap}) reached but all connections are busy; ` + `creating overflow connection (size will be ${connections.size + 1})`,
      )
      return
    }
    const victim = connections.get(victimKey)
    if (!victim) return
    consola.debug(`[upstream-ws] Evicting idle connection ${victimKey} to enforce pool cap (${cap})`)
    victim.close()
    // onClose handler will delete from connections + lastUsedAt
  }

  /**
   * Evicts however many idle connections are needed to bring the pool back
   * within `cap`, counted ONCE up front — unlike callers that loop on
   * `connections.size` shrinking, this must not re-read `connections.size`
   * mid-loop: a real connection's close() only removes its entry from
   * `connections` asynchronously (the manager's `onClose` callback fires
   * when the underlying WS "close" event arrives, not synchronously inside
   * `.close()`), so re-checking `connections.size` after each eviction would
   * see it unchanged and the loop would stop after evicting at most one
   * connection, silently leaving the pool oversized (spec §4 HIGH-5).
   */
  const evictExcessIdleConnections = () => {
    const cap = getMaxConnections()
    if (cap <= 0) return
    const excess = connections.size - cap
    for (let i = 0; i < excess; i++) evictOneIdleIfNeeded()
  }

  return {
    findReusable({ previousResponseId, conversationId, model }) {
      if (stopped) return undefined
      if (isDisabled(model)) return undefined

      // Primary key: statefulMarker matches (strongest — upstream state chained)
      if (previousResponseId) {
        for (const [key, connection] of connections) {
          if (!connection.isOpen) continue
          if (connection.isBusy) continue
          if (connection.model !== model) continue
          if (connection.statefulMarker === previousResponseId) {
            touch(key)
            return connection
          }
        }
      }

      // Fallback key: same conversation — reuse an idle connection when the
      // client did not chain via previous_response_id (e.g. first turn of a
      // conversation after server-side context reset, or proxy does not expose
      // upstream response IDs back to the client).
      //
      // When multiple connections share a conversationId (the client made
      // parallel turns), prefer the most-recently-used one — it has the
      // freshest TCP state and is most likely to still pass an upstream
      // liveness check. Without this we'd pick the first-inserted (oldest)
      // connection, which is more likely to be sitting on a stale socket.
      if (conversationId) {
        let bestKey: string | null = null
        let bestLastUsed = -1
        let bestConn: UpstreamWsConnection | undefined
        for (const [key, connection] of connections) {
          if (!connection.isOpen) continue
          if (connection.isBusy) continue
          if (connection.model !== model) continue
          if (connection.conversationId !== conversationId) continue
          const lru = lastUsedAt.get(key) ?? 0
          if (lru > bestLastUsed) {
            bestLastUsed = lru
            bestKey = key
            bestConn = connection
          }
        }
        if (bestKey !== null && bestConn) {
          touch(bestKey)
          return bestConn
        }
      }

      return undefined
    },

    create({ headers, model, conversationId }) {
      if (stopped) throw new Error("Upstream WebSocket manager is not accepting new work")

      evictOneIdleIfNeeded()

      const key = randomUUID()
      const connection = connectionFactory({
        headers,
        model,
        conversationId,
        idleTimeoutMs: getPooledConnectionIdleTimeoutMs(),
        onClose: () => {
          connections.delete(key)
          lastUsedAt.delete(key)
          connectionGeneration.delete(key)
        },
        onIdle: () => evictOneIdleIfNeeded(),
      })
      connections.set(key, connection)
      connectionGeneration.set(key, currentGeneration)
      touch(key)
      return Promise.resolve(connection)
    },

    stopNew() {
      stopped = true
    },

    closeAll() {
      for (const connection of connections.values()) {
        connection.close()
      }
      connections.clear()
      lastUsedAt.clear()
      connectionGeneration.clear()
    },

    resetRuntimeState() {
      stopped = false
      breaker.clear()
      this.closeAll()
    },

    recordSuccessfulStart(key) {
      // Lazy GC: a success ends the failure episode — drop the entry entirely so
      // only failing/disabled models occupy a slot. Equivalent to resetting to
      // clean. Do NOT add a read-path sweep of clean entries: `recordSuccessfulStart`
      // is the ONLY delete point, and it is unreachable while a model is disabled
      // (the `canUseUpstreamWebSocket` gate is false → attempt never runs → no
      // success), so a disabled entry survives its whole episode and
      // `wasDisabledRecently` (below) stays correct.
      breaker.delete(key)
    },

    recordFallback(key) {
      const now = Date.now()
      const entry = breaker.get(key) ?? { consecutiveFallbacks: 0, disabledUntil: 0 }
      // Inside an armed disabled window, the counter must NOT keep incrementing.
      // Otherwise `consecutive_fallbacks` (exposed in /api/status) drifts into
      // meaningless large numbers under chronic intermittent failures — the
      // counter's purpose is to track "consecutive failures since last success",
      // not "total failures ever". Frozen-while-disabled keeps it stable at the
      // threshold value (or whatever it grew to on the half-open probe).
      const armedAndInsideWindow = entry.disabledUntil > 0 && now < entry.disabledUntil
      if (armedAndInsideWindow) {
        breaker.set(key, entry)
        return
      }

      entry.consecutiveFallbacks += 1
      if (entry.consecutiveFallbacks < MAX_CONSECUTIVE_WS_FALLBACKS) {
        breaker.set(key, entry)
        return
      }

      // Only arm the window on transitions:
      //   1. First time we cross the failure threshold.
      //   2. We were previously disabled, the window elapsed, a probe was
      //      allowed (the call that produced this recordFallback), and that
      //      probe failed.
      // The armed-window early return above means we never reach here while
      // already disabled, so this assignment is always a transition.
      const wasDisabledRecently = entry.disabledUntil > 0
      entry.disabledUntil = now + DISABLE_RECOVERY_WINDOW_MS
      breaker.set(key, entry)
      consola.warn(
        `[upstream-ws] ${wasDisabledRecently ? "Half-open probe failed" : `Temporarily disabled after ${entry.consecutiveFallbacks} consecutive fallbacks`} (model=${key}); `
          + `will retry in ${DISABLE_RECOVERY_WINDOW_MS / 60_000} min`,
      )
    },

    get activeCount() {
      let count = 0
      for (const connection of connections.values()) {
        if (connection.isOpen) count += 1
      }
      return count
    },

    consecutiveFallbacks(key) {
      return breaker.get(key)?.consecutiveFallbacks ?? 0
    },

    temporarilyDisabled(key) {
      return isDisabled(key)
    },

    disabledUntilMs(key) {
      // Always report the raw timestamp — consumers can compare with Date.now()
      // themselves and decide whether to surface "X seconds until retry".
      return breaker.get(key)?.disabledUntil ?? 0
    },

    breakerSnapshot() {
      const now = Date.now()
      const rows: Array<WsBreakerSnapshotRow> = []
      for (const [model, entry] of breaker) {
        rows.push({
          model,
          consecutiveFallbacks: entry.consecutiveFallbacks,
          temporarilyDisabled: now < entry.disabledUntil,
          disabledUntilMs: entry.disabledUntil,
        })
      }
      return rows
    },

    /**
     * Hot-reload reconcile (P4 major fix, spec §4 D7 HIGH-3): must NEVER
     * throw. This runs as one of possibly several synchronous listeners
     * inside state.ts's `setUpstreamTransportConfig()` listener loop (`for
     * (const listener of transportUpstreamListeners) listener()` — no
     * try/catch there), sharing that loop with the h2-side reconcile listener
     * and proxy.ts's dispatcher-rebuild listener. A thrown error here would
     * abort the loop and silently skip every listener registered after this
     * one — exactly the "silently skip later subscribers" failure mode HIGH-3
     * calls out, and exactly what `reconcileH2SessionsForConfigChange`
     * (http2-client.ts) already guards against; this mirrors that guard so
     * the WS side carries the same defense instead of leaving it half-implemented.
     * Any failure (e.g. a connection's `rescheduleIdleTimeout` throwing) is
     * caught, recorded (`reconcileRunState`/`lastReconcileError`, observable
     * via `reconcileStatus()`/P5's `getUpstreamWsReconcileStatus()`) and
     * logged via consola.error — never silently swallowed, never re-thrown.
     */
    reconcileForConfigChange(newIdleTimeoutMs) {
      reconcileRunState = "running"
      try {
        currentGeneration += 1
        for (const [key, connection] of connections) {
          connection.rescheduleIdleTimeout(newIdleTimeoutMs)
          connectionGeneration.set(key, currentGeneration)
        }
        // The soft-max cap may have shrunk — evict now-excess IDLE connections
        // down to it. Busy connections are left untouched (see Architecture).
        // evictExcessIdleConnections() computes the excess ONCE up front — see
        // its own doc comment for why re-checking connections.size mid-loop
        // would silently under-evict.
        evictExcessIdleConnections()
        lastCompletedReconcileGeneration = currentGeneration
        lastReconcileError = null
        reconcileRunState = "idle"
      } catch (err) {
        reconcileRunState = "failed"
        lastReconcileError = err instanceof Error ? err.message : String(err)
        consola.error(`[upstream-ws] reconcileForConfigChange failed (generation=${currentGeneration}): ${lastReconcileError}`)
        // Deliberately NOT re-thrown — see the doc comment above.
      }
    },

    statusSnapshot() {
      const rows: Array<UpstreamWsStatusRow> = []
      for (const [key, connection] of connections) {
        let connectionState: UpstreamWsStatusRow["state"] = "idle"
        if (!connection.isOpen) connectionState = "connecting"
        else if (connection.isBusy) connectionState = "busy"
        rows.push({
          key,
          model: connection.model,
          state: connectionState,
          generation: connectionGeneration.get(key) ?? 0,
        })
      }
      return rows
    },

    reconcileStatus() {
      return { state: reconcileRunState, lastCompletedGeneration: lastCompletedReconcileGeneration, lastError: lastReconcileError }
    },

    get stopped() {
      return stopped
    },
  }
}

let manager: UpstreamWsManager | null = null
let wsReconcileSubscriptionInstalled = false

export function getUpstreamWsManager(): UpstreamWsManager {
  manager ??= createUpstreamWsManager({
    // Read the cap from runtime state on every eviction so config hot-reload
    // takes effect without recreating the manager (which would drop all
    // pooled connections).
    maxConnections: () => state.softMaxUpstreamWsConnections,
  })
  // Lazy-once subscription (P4), mirroring proxy.ts's ensureTimeoutSubscription().
  // References the outer `manager` variable (not a snapshot), so this correctly
  // targets whatever manager instance is current even after
  // resetUpstreamWsManagerForTests() swaps it out.
  if (!wsReconcileSubscriptionInstalled) {
    onUpstreamTransportChange(() => {
      manager?.reconcileForConfigChange(getPooledConnectionIdleTimeoutMs())
    })
    wsReconcileSubscriptionInstalled = true
  }
  return manager
}

export function peekUpstreamWsManager(): UpstreamWsManager | null {
  return manager
}

export function resetUpstreamWsManagerForTests(options?: CreateUpstreamWsManagerOptions): UpstreamWsManager {
  manager?.closeAll()
  manager = createUpstreamWsManager(options)
  return manager
}

export function setUpstreamWsConnectionFactoryForTests(factory: ((opts: CreateUpstreamWsConnectionOptions) => UpstreamWsConnection) | null): void {
  connectionFactory = factory ?? createUpstreamWsConnection
}

/** Free-function wrapper (README "P4 produces, P5 consumes" signature) — the manager itself owns the per-connection state, so this just delegates. */
export function getUpstreamWsStatusSnapshot(manager: UpstreamWsManager): ReadonlyArray<UpstreamWsStatusRow> {
  return manager.statusSnapshot()
}

/** Free-function wrapper (README "P4 produces, P5 consumes" signature) — mirrors {@link getUpstreamWsStatusSnapshot}'s delegation pattern. */
export function getUpstreamWsReconcileStatus(manager: UpstreamWsManager): UpstreamWsReconcileStatus {
  return manager.reconcileStatus()
}
