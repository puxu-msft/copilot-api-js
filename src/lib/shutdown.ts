// Centralized graceful shutdown management
// Coordinates token refresh stop, WebSocket cleanup, server close, and exit

import type { Server } from "srvx"

import consola from "consola"

import { closeAllClients, getClientCount } from "./history-ws"
import { stopTokenRefresh } from "./token"

let serverInstance: Server | null = null
let isShuttingDown = false
let shutdownResolve: (() => void) | null = null

/** Max time (ms) to wait for in-flight requests to finish before force-exiting */
const DRAIN_TIMEOUT_MS = 30_000

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

/** Perform graceful shutdown */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  consola.info(`Received ${signal}, shutting down gracefully...`)

  // Stop token refresh timers first to prevent in-flight refresh requests
  stopTokenRefresh()

  // Close all WebSocket clients
  const wsClients = getClientCount()
  if (wsClients > 0) {
    closeAllClients()
    consola.info(`Disconnected ${wsClients} WebSocket client(s)`)
  }

  // Close the HTTP server — stops accepting new connections
  // and waits for in-flight requests to drain (Bun.Server.stop(false))
  if (serverInstance) {
    try {
      consola.info("Waiting for in-flight requests to complete...")
      const drainPromise = serverInstance.close()
      const timeoutPromise = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS))

      const result = await Promise.race([drainPromise, timeoutPromise])
      if (result === "timeout") {
        consola.warn(`Drain timeout (${DRAIN_TIMEOUT_MS / 1000}s) reached, force-closing connections`)
        await serverInstance.close(true)
      }
    } catch (error) {
      consola.error("Error closing server:", error)
    }
  }

  consola.info("Shutdown complete")

  // Resolve the waitForShutdown promise, allowing runServer() to return naturally
  // No process.exit() — let the event loop drain so srvx/Bun can finish cleanup
  shutdownResolve?.()
}

/** Setup process signal handlers for graceful shutdown */
export function setupShutdownHandlers(): void {
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"))
}
