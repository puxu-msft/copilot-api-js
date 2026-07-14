import consola from "consola"
import { randomUUID } from "node:crypto"

// `state` is read inside the singleton getter only; state.ts does not import
// back into upstream-ws*, so this is a safe top-level edge in the module
// graph. If a future change to state.ts introduces a cycle this import should
// be moved inside the getter via dynamic import.
import { state } from "~/lib/state"

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
        onClose: () => {
          connections.delete(key)
          lastUsedAt.delete(key)
        },
      })
      connections.set(key, connection)
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

    get stopped() {
      return stopped
    },
  }
}

let manager: UpstreamWsManager | null = null

export function getUpstreamWsManager(): UpstreamWsManager {
  manager ??= createUpstreamWsManager({
    // Read the cap from runtime state on every eviction so config hot-reload
    // takes effect without recreating the manager (which would drop all
    // pooled connections).
    maxConnections: () => state.softMaxUpstreamWsConnections,
  })
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
