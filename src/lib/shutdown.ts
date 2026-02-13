/**
 * Centralized graceful shutdown management.
 *
 * Coordinates a 4-phase shutdown sequence:
 *   Phase 1 (0s):       Stop accepting new requests, drain rate limiter queue
 *   Phase 2 (0–20s):    Wait for in-flight requests to complete naturally
 *   Phase 3 (20–140s):  Fire abort signal, wait for handlers to wrap up
 *   Phase 4 (140s):     Force-close all connections, clean up
 *
 * Handlers integrate via getShutdownSignal() to detect Phase 3 abort.
 */

import type { Server } from "srvx"

import consola from "consola"

import type { TuiLogEntry } from "./tui"

import type { AdaptiveRateLimiter } from "./adaptive-rate-limiter"

import { closeAllClients, getClientCount } from "./history"
import { stopTokenRefresh } from "./token"
import { tuiLogger } from "./tui"
import { getAdaptiveRateLimiter } from "./adaptive-rate-limiter"

// ============================================================================
// Configuration constants
// ============================================================================

/** Phase 2 timeout: wait for in-flight requests to complete naturally */
export const GRACEFUL_WAIT_MS = 20_000
/** Phase 3 timeout: wait after abort signal for handlers to wrap up */
export const ABORT_WAIT_MS = 120_000
/** Polling interval during drain */
export const DRAIN_POLL_INTERVAL_MS = 500
/** Progress log interval during drain */
export const DRAIN_PROGRESS_INTERVAL_MS = 5_000

// ============================================================================
// Module state
// ============================================================================

let serverInstance: Server | null = null
let _isShuttingDown = false
let shutdownResolve: (() => void) | null = null
let shutdownAbortController: AbortController | null = null

// ============================================================================
// Public API
// ============================================================================

/** Check if the server is in shutdown state (used by middleware to reject new requests) */
export function getIsShuttingDown(): boolean {
  return _isShuttingDown
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
export function setServerInstance(server: Server): void {
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
  opts?: { pollIntervalMs?: number; progressIntervalMs?: number },
): Promise<"drained" | "timeout"> {
  const pollInterval = opts?.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS
  const progressInterval = opts?.progressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  let lastProgressLog = 0

  while (Date.now() < deadline) {
    const active = tracker.getActiveRequests()
    if (active.length === 0) return "drained"

    // Log progress periodically
    const now = Date.now()
    if (now - lastProgressLog >= progressInterval) {
      lastProgressLog = now
      consola.info(formatActiveRequestsSummary(active))
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
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

  // ── Phase 1: Stop accepting new requests ──────────────────────────────
  _isShuttingDown = true
  shutdownAbortController = new AbortController()

  consola.info(`Received ${signal}, shutting down gracefully...`)

  // Stop background services
  stopRefresh()

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

  // Stop listening for new connections (but keep existing ones alive)
  if (server) {
    try {
      await server.close(false)
      consola.info("Stopped accepting new connections")
    } catch (error) {
      consola.error("Error stopping listener:", error)
    }
  }

  // ── Phase 2: Wait for natural completion ──────────────────────────────
  const activeCount = tracker.getActiveRequests().length
  if (activeCount > 0) {
    consola.info(`Phase 2: Waiting up to ${GRACEFUL_WAIT_MS / 1000}s for ${activeCount} active request(s)...`)

    try {
      const phase2Result = await drainActiveRequests(GRACEFUL_WAIT_MS, tracker)
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
      + `waiting up to ${ABORT_WAIT_MS / 1000}s...`,
    )

    shutdownAbortController.abort()

    try {
      const phase3Result = await drainActiveRequests(ABORT_WAIT_MS, tracker)
      if (phase3Result === "drained") {
        consola.info("All requests completed after abort signal")
        finalize(tracker)
        return
      }
    } catch (error) {
      consola.error("Error during Phase 3 drain:", error)
    }

    // ── Phase 4: Force close ────────────────────────────────────────────
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
  tracker.destroy()
  consola.info("Shutdown complete")
  shutdownResolve?.()
}

// ============================================================================
// Signal handlers
// ============================================================================

/** Setup process signal handlers for graceful shutdown */
export function setupShutdownHandlers(): void {
  const handler = (signal: string) => {
    if (_isShuttingDown) {
      // Second signal = force exit immediately
      consola.warn("Second signal received, forcing immediate exit")
      process.exit(1)
    }
    gracefulShutdown(signal).catch((error) => {
      consola.error("Fatal error during shutdown:", error)
      shutdownResolve?.() // Ensure waitForShutdown resolves even on error
      process.exit(1)
    })
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
  serverInstance = null
}
