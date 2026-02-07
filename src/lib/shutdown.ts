// Centralized graceful shutdown management
// Coordinates token refresh stop, WebSocket cleanup, request draining, and server close

import type { Server } from "srvx"

import consola from "consola"

import type { TrackedRequest } from "./tui"

import { closeAllClients, getClientCount } from "./history-ws"
import { stopTokenRefresh } from "./token"
import { requestTracker } from "./tui"

let serverInstance: Server | null = null
let _isShuttingDown = false
let shutdownResolve: (() => void) | null = null

/** Drain timeouts based on active request types */
const THINKING_DRAIN_TIMEOUT_MS = 180_000 // 3min — thinking responses can take 120s+
const NORMAL_DRAIN_TIMEOUT_MS = 60_000 // 1min — normal streaming responses ~15s
const MIN_DRAIN_TIMEOUT_MS = 5_000 // 5s — no active requests, just wait briefly
const DRAIN_POLL_INTERVAL_MS = 500
const DRAIN_PROGRESS_INTERVAL_MS = 5_000 // log progress every 5s

/** Check if the server is in shutdown state (used by middleware to reject new requests) */
export function getIsShuttingDown(): boolean {
  return _isShuttingDown
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

/**
 * Compute drain timeout based on currently active requests.
 * Thinking requests get more time because they can take 120s+.
 */
function computeDrainTimeout(): number {
  const active = requestTracker.getActiveRequests()
  if (active.length === 0) return MIN_DRAIN_TIMEOUT_MS

  // Check for thinking requests via tags set by handlers
  const hasThinking = active.some((r) => r.tags?.some((t) => t.startsWith("thinking:")))
  return hasThinking ? THINKING_DRAIN_TIMEOUT_MS : NORMAL_DRAIN_TIMEOUT_MS
}

/** Log a summary of active requests during drain */
function logActiveRequestsSummary(requests: Array<TrackedRequest>): void {
  const now = Date.now()
  const lines = requests.map((req) => {
    const age = Math.round((now - req.startTime) / 1000)
    const model = req.model || "unknown"
    const tags = req.tags?.length ? ` [${req.tags.join(", ")}]` : ""
    return `  ${req.method} ${req.path} ${model} (${req.status}, ${age}s)${tags}`
  })
  consola.info(`Waiting for ${requests.length} active request(s):\n${lines.join("\n")}`)
}

/**
 * Wait for all active requests to complete, with periodic progress logging.
 * Returns "drained" when all requests finish, "timeout" if deadline is reached.
 */
async function drainActiveRequests(timeoutMs: number): Promise<"drained" | "timeout"> {
  const deadline = Date.now() + timeoutMs
  let lastProgressLog = 0

  while (Date.now() < deadline) {
    const active = requestTracker.getActiveRequests()
    if (active.length === 0) return "drained"

    // Log progress periodically
    const now = Date.now()
    if (now - lastProgressLog >= DRAIN_PROGRESS_INTERVAL_MS) {
      lastProgressLog = now
      logActiveRequestsSummary(active)
    }

    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS))
  }

  return "timeout"
}

/** Perform graceful shutdown */
async function gracefulShutdown(signal: string): Promise<void> {
  _isShuttingDown = true // Middleware will immediately start rejecting new requests

  consola.info(`Received ${signal}, shutting down gracefully...`)

  // Phase 1: Stop background services
  stopTokenRefresh()

  const wsClients = getClientCount()
  if (wsClients > 0) {
    closeAllClients()
    consola.info(`Disconnected ${wsClients} WebSocket client(s)`)
  }

  // Phase 2: Drain active requests
  if (serverInstance) {
    const activeCount = requestTracker.getActiveRequests().length
    const drainTimeout = computeDrainTimeout()

    if (activeCount > 0) {
      consola.info(`Draining ${activeCount} active request(s), timeout ${drainTimeout / 1000}s`)

      const result = await drainActiveRequests(drainTimeout)
      if (result === "timeout") {
        const remaining = requestTracker.getActiveRequests()
        consola.warn(`Drain timeout, force-closing ${remaining.length} remaining request(s)`)
      } else {
        consola.info("All requests completed")
      }
    }

    // Phase 3: Close server (force=true — either already drained or timed out)
    try {
      await serverInstance.close(true)
    } catch (error) {
      consola.error("Error closing server:", error)
    }
  }

  consola.info("Shutdown complete")
  shutdownResolve?.()
}

/** Setup process signal handlers for graceful shutdown */
export function setupShutdownHandlers(): void {
  const handler = (signal: string) => {
    if (_isShuttingDown) {
      // Second signal = force exit immediately
      consola.warn("Second signal received, forcing immediate exit")
      process.exit(1)
    }
    void gracefulShutdown(signal)
  }
  process.on("SIGINT", () => handler("SIGINT"))
  process.on("SIGTERM", () => handler("SIGTERM"))
}
