/**
 * Centralized graceful shutdown management.
 *
 * Coordinates a 4-phase shutdown sequence:
 *   Phase 1 (0s):       Stop accepting new requests, drain rate limiter queue
 *   Phase 2 (0–Ns):     Wait for in-flight requests to complete naturally
 *   Phase 3 (N–N+Ms):   Fire abort signal, wait for handlers to wrap up
 *   Phase 4:            Force-close all connections, clean up
 *
 * Phase 2/3 timeouts are configurable via state.shutdownGracefulWait and
 * state.shutdownAbortWait (seconds), set from config.yaml `shutdown` section.
 *
 * Handlers integrate via getShutdownSignal() to detect Phase 3 abort.
 */

import type { ServerInstance } from "./serve"

import consola from "consola"

import type { AdaptiveRateLimiter } from "./adaptive-rate-limiter"
import type { TuiLogEntry } from "./tui"

import { getAdaptiveRateLimiter } from "./adaptive-rate-limiter"
import { getRequestContextManager } from "./context/manager"
import { closeAllClients, getClientCount, stopMemoryPressureMonitor } from "./history"
import { state } from "./state"
import { stopTokenRefresh } from "./token"
import { tuiLogger } from "./tui"
import { notifyShutdownPhaseChanged } from "./ws"

// ============================================================================
// Configuration constants
// ============================================================================

/** Polling interval during drain */
export const DRAIN_POLL_INTERVAL_MS = 500
/** Progress log interval during drain */
export const DRAIN_PROGRESS_INTERVAL_MS = 5_000

// ============================================================================
// Module state
// ============================================================================

let serverInstance: ServerInstance | null = null
let _isShuttingDown = false
let shutdownResolve: (() => void) | null = null
let shutdownAbortController: AbortController | null = null
let shutdownDrainAbortController: AbortController | null = null
let shutdownPhase: "idle" | "phase1" | "phase2" | "phase3" | "phase4" | "finalized" = "idle"
let shutdownPromise: Promise<void> | null = null

/** Transition shutdown phase and broadcast via WebSocket */
function setPhase(phase: typeof shutdownPhase): void {
  const prev = shutdownPhase
  shutdownPhase = phase
  if (prev !== phase) {
    notifyShutdownPhaseChanged({ phase, previousPhase: prev })
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Check if the server is in shutdown state (used by middleware to reject new requests) */
export function getIsShuttingDown(): boolean {
  return _isShuttingDown
}

/** Get the current shutdown phase */
export function getShutdownPhase(): typeof shutdownPhase {
  return shutdownPhase
}

/**
 * Get the shutdown abort signal.
 * Returns undefined before shutdown starts. During Phase 1–2 the signal is
 * not aborted; it fires at Phase 3 to tell handlers to wrap up.
 */
export function getShutdownSignal(): AbortSignal | undefined {
  return shutdownAbortController?.signal
}

/**
 * Returns a promise that resolves when the server is shut down via signal.
 * Used by runServer() to keep the async function alive until shutdown.
 */
export function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    shutdownResolve = resolve
  })
}

/** Store the server instance for shutdown */
export function setServerInstance(server: ServerInstance): void {
  serverInstance = server
}

// ============================================================================
// Dependency injection for testing
// ============================================================================

/** Dependencies that can be injected for testing */
export interface ShutdownDeps {
  tracker?: {
    getActiveRequests: () => Array<TuiLogEntry>
    destroy: () => void
  }
  server?: {
    close: (force?: boolean) => Promise<void>
  }
  rateLimiter?: AdaptiveRateLimiter | null
  stopTokenRefreshFn?: () => void
  closeAllClientsFn?: () => void
  getClientCountFn?: () => number
  /** Request context manager (for stopping stale reaper during shutdown) */
  contextManager?: { stopReaper: () => void }
  /** Timing overrides (for testing — avoids real 20s/120s waits) */
  gracefulWaitMs?: number
  abortWaitMs?: number
  drainPollIntervalMs?: number
  drainProgressIntervalMs?: number
}

// ============================================================================
// Drain logic
// ============================================================================

/** Format a summary of active requests for logging */
export function formatActiveRequestsSummary(requests: Array<TuiLogEntry>): string {
  const now = Date.now()
  const lines = requests.map((req) => {
    const age = Math.round((now - req.startTime) / 1000)
    const model = req.model || "unknown"
    const tags = req.tags?.length ? ` [${req.tags.join(", ")}]` : ""
    return `  ${req.method} ${req.path} ${model} (${req.status}, ${age}s)${tags}`
  })
  return `Waiting for ${requests.length} active request(s):\n${lines.join("\n")}`
}

/**
 * Wait for all active requests to complete, with periodic progress logging.
 * Returns "drained" when all requests finish, "timeout" if deadline is reached.
 */
export async function drainActiveRequests(
  timeoutMs: number,
  tracker: { getActiveRequests: () => Array<TuiLogEntry> },
  opts?: { pollIntervalMs?: number; progressIntervalMs?: number; abortSignal?: AbortSignal },
): Promise<"drained" | "timeout" | "aborted"> {
  const pollInterval = opts?.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS
  const progressInterval = opts?.progressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS
  const abortSignal = opts?.abortSignal
  const deadline = Date.now() + timeoutMs
  let lastProgressLog = 0

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) return "aborted"

    const active = tracker.getActiveRequests()
    if (active.length === 0) return "drained"

    // Log progress periodically
    const now = Date.now()
    if (now - lastProgressLog >= progressInterval) {
      lastProgressLog = now
      consola.info(formatActiveRequestsSummary(active))
    }

    const waitResult = await new Promise<"timer" | "aborted">((resolve) => {
      let settled = false
      let onAbort: (() => void) | undefined

      const finish = (value: "timer" | "aborted") => {
        if (settled) return
        settled = true
        if (abortSignal && onAbort) {
          abortSignal.removeEventListener("abort", onAbort)
        }
        resolve(value)
      }

      const timeoutId = setTimeout(() => finish("timer"), pollInterval)
      if (!abortSignal) return

      onAbort = () => {
        clearTimeout(timeoutId)
        finish("aborted")
      }

      abortSignal.addEventListener("abort", onAbort, { once: true })
    })

    if (waitResult === "aborted") return "aborted"
  }

  return "timeout"
}

// ============================================================================
// Graceful shutdown (4 phases)
// ============================================================================

/**
 * Perform graceful shutdown in 4 phases.
 *
 * @param signal - The signal that triggered shutdown (e.g. "SIGINT")
 * @param deps - Optional dependency injection for testing
 */
export async function gracefulShutdown(signal: string, deps?: ShutdownDeps): Promise<void> {
  const tracker = deps?.tracker ?? tuiLogger
  const server = deps?.server ?? serverInstance
  const rateLimiter = deps?.rateLimiter !== undefined ? deps.rateLimiter : getAdaptiveRateLimiter()
  const stopRefresh = deps?.stopTokenRefreshFn ?? stopTokenRefresh
  const closeWsClients = deps?.closeAllClientsFn ?? closeAllClients
  const getWsClientCount = deps?.getClientCountFn ?? getClientCount

  // Timing (defaults to state values from config, overridable for testing)
  const gracefulWaitMs = deps?.gracefulWaitMs ?? state.shutdownGracefulWait * 1000
  const abortWaitMs = deps?.abortWaitMs ?? state.shutdownAbortWait * 1000
  const drainOpts = {
    pollIntervalMs: deps?.drainPollIntervalMs ?? DRAIN_POLL_INTERVAL_MS,
    progressIntervalMs: deps?.drainProgressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS,
  }

  // ── Phase 1: Stop accepting new requests ──────────────────────────────
  _isShuttingDown = true
  shutdownAbortController = new AbortController()
  setPhase("phase1")

  consola.info(`Received ${signal}, shutting down gracefully...`)

  // Stop stale context reaper before drain (avoid racing with drain logic)
  try {
    const ctxMgr = deps?.contextManager ?? getRequestContextManager()
    ctxMgr.stopReaper()
  } catch {
    // Context manager may not be initialized in tests or early shutdown
  }

  // Stop background services
  stopRefresh()
  stopMemoryPressureMonitor()

  const wsClients = getWsClientCount()
  if (wsClients > 0) {
    closeWsClients()
    consola.info(`Disconnected ${wsClients} WebSocket client(s)`)
  }

  // Drain rate limiter queue immediately
  if (rateLimiter) {
    const rejected = rateLimiter.rejectQueued()
    if (rejected > 0) {
      consola.info(`Rejected ${rejected} queued request(s) from rate limiter`)
    }
  }

  // Stop listening for new connections (but keep existing ones alive).
  // Do NOT await — server.close(false) stops accepting new connections immediately,
  // but the returned promise won't resolve until all existing connections end.
  // Upgraded WebSocket connections (even after close handshake) keep the HTTP
  // server open indefinitely, which would block the entire shutdown sequence.
  if (server) {
    server.close(false).catch((error: unknown) => {
      consola.error("Error stopping listener:", error)
    })
    consola.info("Stopped accepting new connections")
  }

  // ── Phase 2: Wait for natural completion ──────────────────────────────
  const activeCount = tracker.getActiveRequests().length
  if (activeCount > 0) {
    consola.info(`Phase 2: Waiting up to ${gracefulWaitMs / 1000}s for ${activeCount} active request(s)...`)
    setPhase("phase2")
    shutdownDrainAbortController = new AbortController()

    try {
      const phase2Result = await drainActiveRequests(gracefulWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase2Result === "drained") {
        consola.info("All requests completed naturally")
        finalize(tracker)
        return
      }
    } catch (error) {
      consola.error("Error during Phase 2 drain:", error)
    }

    // ── Phase 3: Abort signal + extended wait ─────────────────────────────
    const remaining = tracker.getActiveRequests().length
    consola.info(
      `Phase 3: Sending abort signal to ${remaining} remaining request(s), `
        + `waiting up to ${abortWaitMs / 1000}s...`,
    )

    setPhase("phase3")
    shutdownDrainAbortController = new AbortController()
    shutdownAbortController.abort()

    try {
      const phase3Result = await drainActiveRequests(abortWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase3Result === "drained") {
        consola.info("All requests completed after abort signal")
        finalize(tracker)
        return
      }
    } catch (error) {
      consola.error("Error during Phase 3 drain:", error)
    }

    // ── Phase 4: Force close ────────────────────────────────────────────
    setPhase("phase4")
    const forceRemaining = tracker.getActiveRequests().length
    consola.warn(`Phase 4: Force-closing ${forceRemaining} remaining request(s)`)

    if (server) {
      try {
        await server.close(true)
      } catch (error) {
        consola.error("Error force-closing server:", error)
      }
    }
  }

  finalize(tracker)
}

/** Final cleanup after drain/force-close */
function finalize(tracker: { destroy: () => void }): void {
  setPhase("finalized")
  shutdownDrainAbortController = null
  tracker.destroy()
  consola.info("Shutdown complete")
  shutdownResolve?.()
}

// ============================================================================
// Signal handlers
// ============================================================================

interface HandleShutdownSignalOptions {
  gracefulShutdownFn?: (signal: string) => Promise<void>
  exitFn?: (code: number) => void
}

export function handleShutdownSignal(signal: string, opts?: HandleShutdownSignalOptions): Promise<void> | undefined {
  const shutdownFn = opts?.gracefulShutdownFn ?? ((shutdownSignal: string) => gracefulShutdown(shutdownSignal))
  const exitFn = opts?.exitFn ?? ((code: number) => process.exit(code))

  if (_isShuttingDown) {
    if (shutdownPhase === "phase2") {
      consola.warn("Second signal received, escalating shutdown to abort active requests")
      shutdownDrainAbortController?.abort()
      return shutdownPromise ?? undefined
    }

    if (shutdownPhase === "phase3") {
      consola.warn("Additional signal received, escalating shutdown to force-close remaining requests")
      shutdownDrainAbortController?.abort()
      return shutdownPromise ?? undefined
    }

    consola.warn("Additional signal received during forced shutdown, exiting immediately")
    exitFn(1)
    return shutdownPromise ?? undefined
  }

  shutdownPromise = shutdownFn(signal).catch((error: unknown) => {
      consola.error("Fatal error during shutdown:", error)
      shutdownResolve?.() // Ensure waitForShutdown resolves even on error
      exitFn(1)
    })
  return shutdownPromise
}

/** Setup process signal handlers for graceful shutdown */
export function setupShutdownHandlers(): void {
  const handler = (signal: string) => {
    handleShutdownSignal(signal)
  }
  process.on("SIGINT", () => handler("SIGINT"))
  process.on("SIGTERM", () => handler("SIGTERM"))
}

// ============================================================================
// Testing utilities
// ============================================================================

/** Reset module state (for tests only) */
export function _resetShutdownState(): void {
  _isShuttingDown = false
  shutdownResolve = null
  shutdownAbortController = null
  shutdownDrainAbortController = null
  shutdownPhase = "idle"
  shutdownPromise = null
  serverInstance = null
}
