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

import consola from "consola"
import { setMaxListeners } from "node:events"

import type { AdaptiveRateLimiter } from "./adaptive-rate-limiter"
import type { ServerInstance } from "./serve"
import type { TuiLogEntry } from "./tui"

import { getAdaptiveRateLimiter } from "./adaptive-rate-limiter"
import { getRequestContextManager } from "./context/manager"
import { shutdownHistory } from "./history"
import { peekUpstreamWsManager } from "./openai/upstream-ws"
import { shutdownRequestTelemetry } from "./request-telemetry"
import { state } from "./state"
import { stopTokenRefresh } from "./token"
import { tuiLogger } from "./tui"
import {
  //
  closeAllClients,
  getClientCount,
  notifyShutdownPhaseChangedAndFlush,
} from "./ws"

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

/**
 * Create the process-global shutdown AbortController.
 *
 * Listener bookkeeping: every in-flight stream/fetch registers an `abort`
 * listener on this signal so a Phase 3 abort can wake it. With many concurrent
 * streams that exceeds Node's default 10-listener warning threshold, so we lift
 * the cap. `setMaxListeners` works on EventTargets (incl. AbortSignal) under
 * Node; under Bun it may be a no-op — that's fine, correctness never depends on
 * it (consumers remove their listeners explicitly), it only silences a warning.
 */
function createShutdownController(): AbortController {
  const controller = new AbortController()
  try {
    setMaxListeners(0, controller.signal)
  } catch {
    // Runtime without setMaxListeners support for EventTargets — non-fatal.
  }
  return controller
}

/**
 * Process-global shutdown signal, created EAGERLY (not lazily at Phase 1) and
 * aborted exactly once at Phase 3. Being stable from process start means a
 * request that blocks on `iterator.next()` / `fetch()` BEFORE shutdown begins
 * still has this signal registered in its abort race, so the Phase 3 abort wakes
 * it. (A lazily-created signal would leave such already-blocked waits deaf to a
 * signal that only materialized later.)
 */
let shutdownAbortController: AbortController = createShutdownController()
let shutdownDrainAbortController: AbortController | null = null
let shutdownPhase: "idle" | "phase1" | "phase2" | "phase3" | "phase4" | "finalized" = "idle"
let shutdownPromise: Promise<void> | null = null

/**
 * Transition shutdown phase and broadcast via WebSocket. Returns a promise
 * that resolves once the broadcast frame has actually drained on every
 * status-subscribed client (or the deadline elapses). Callers that are about
 * to force-close sockets MUST await this; callers in the middle of a normal
 * phase progression can fire-and-forget via `setPhaseFireAndForget`.
 */
function setPhase(phase: typeof shutdownPhase): Promise<{ stillBuffering: number }> {
  const prev = shutdownPhase
  shutdownPhase = phase
  if (prev === phase) return Promise.resolve({ stillBuffering: 0 })
  return notifyShutdownPhaseChangedAndFlush({ phase, previousPhase: prev })
}

/**
 * Fire-and-forget variant that swallows broadcast errors. Use for phases
 * (1/2/3) that don't precede a force-close — we don't want to add 500ms of
 * broadcast deadline to the shutdown sequence, and an unhandled rejection from
 * `broadcastAndFlush` (extremely unlikely, but theoretically possible if a
 * client's send() throws synchronously in some adapter) would otherwise crash
 * the process mid-shutdown.
 */
function setPhaseFireAndForget(phase: typeof shutdownPhase): void {
  setPhase(phase).catch((error: unknown) => {
    consola.warn(`[shutdown] phase=${phase} broadcast failed (non-fatal):`, error)
  })
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
 * Get the process-global shutdown abort signal.
 *
 * Stable from process start (never undefined). It is NOT aborted during normal
 * operation or Phase 1–2; it fires at Phase 3 to tell in-flight handlers to wrap
 * up. To test "are we shutting down?", use {@link getIsShuttingDown} (set at
 * Phase 1) — NOT this signal's existence.
 */
export function getShutdownSignal(): AbortSignal {
  return shutdownAbortController.signal
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

      // Hoisted forward reference: declared in if-branch below; finish only
      // touches it when abortSignal is truthy (same condition that assigns it).
      const refs: { onAbort: (() => void) | undefined } = { onAbort: undefined }

      const finish = (value: "timer" | "aborted") => {
        if (settled) return
        settled = true
        if (abortSignal && refs.onAbort) {
          abortSignal.removeEventListener("abort", refs.onAbort)
        }
        resolve(value)
      }

      const timeoutId = setTimeout(() => finish("timer"), pollInterval)
      if (!abortSignal) return

      refs.onAbort = () => {
        clearTimeout(timeoutId)
        finish("aborted")
      }

      abortSignal.addEventListener("abort", refs.onAbort, { once: true })
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
  // NOTE: do NOT recreate shutdownAbortController here. It is created eagerly at
  // module load and reused for the whole process lifetime, so requests that
  // began (and possibly blocked on a stalled upstream) BEFORE this point already
  // hold its signal in their abort race and will observe the Phase 3 abort.
  // Fire-and-forget: phase1/2/3 don't precede force-close, so we don't need
  // to await the broadcast drain. Phase4 + finalized DO await (see below).
  setPhaseFireAndForget("phase1")

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
  shutdownHistory()
  peekUpstreamWsManager()?.stopNew()

  // NOTE: Browser-observer WebSocket clients (history/status dashboards) are
  // NOT closed here. They subscribe to `notifyShutdownPhaseChanged` events;
  // closing them in Phase 1 would prevent users from seeing phase2/3/4/finalized
  // progress in the UI. They are torn down in Phase 4 along with the HTTP
  // server (force close) so the operator can observe the full shutdown timeline.

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
    setPhaseFireAndForget("phase2")
    shutdownDrainAbortController = new AbortController()

    try {
      const phase2Result = await drainActiveRequests(gracefulWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase2Result === "drained") {
        consola.info("All requests completed naturally")
        await finalize(tracker, { closeWsClients, getWsClientCount })
        return
      }
    } catch (error) {
      consola.error("Error during Phase 2 drain:", error)
    }

    // ── Phase 3: Abort signal + extended wait ─────────────────────────────
    const remaining = tracker.getActiveRequests().length
    consola.info(`Phase 3: Sending abort signal to ${remaining} remaining request(s), ` + `waiting up to ${abortWaitMs / 1000}s...`)

    setPhaseFireAndForget("phase3")
    shutdownDrainAbortController = new AbortController()
    shutdownAbortController.abort()

    try {
      const phase3Result = await drainActiveRequests(abortWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase3Result === "drained") {
        consola.info("All requests completed after abort signal")
        await finalize(tracker, { closeWsClients, getWsClientCount })
        return
      }
    } catch (error) {
      consola.error("Error during Phase 3 drain:", error)
    }

    // ── Phase 4: Force close ────────────────────────────────────────────
    // setPhase resolves once the broadcast frame has actually drained on every
    // status-subscribed WS client (or its internal deadline elapses). Awaiting
    // here means the dashboard is guaranteed to see "phase4" before we yank
    // the sockets in the next step.
    await setPhase("phase4")
    const forceRemaining = tracker.getActiveRequests().length
    consola.warn(`Phase 4: Force-closing ${forceRemaining} remaining request(s)`)

    // Close upstream WS connections BEFORE force-closing the downstream server.
    // Order matters: if the downstream HTTP/WS server is force-closed first, any
    // upstream SSE/WS data still in flight gets pushed to a dead writer and
    // surfaces as EPIPE/ECONNRESET noise in logs. Closing the upstream side
    // first lets in-flight forwarders see a clean EOF from their data source.
    peekUpstreamWsManager()?.closeAll()

    // Now close observer WS clients. They've seen all phase transitions up to
    // and including phase4 (guaranteed by the awaited setPhase above).
    const wsClients = getWsClientCount()
    if (wsClients > 0) {
      closeWsClients()
      consola.info(`Disconnected ${wsClients} WebSocket client(s)`)
    }

    if (server) {
      try {
        await server.close(true)
      } catch (error) {
        consola.error("Error force-closing server:", error)
      }
    }
  }

  await finalize(tracker, { closeWsClients, getWsClientCount })
}

interface FinalizeDeps {
  closeWsClients: () => void
  getWsClientCount: () => number
}

/** Final cleanup after drain/force-close */
async function finalize(tracker: { destroy: () => void }, deps: FinalizeDeps): Promise<void> {
  // Await the broadcast drain so dashboards reliably see "finalized" before we
  // close their sockets in the graceful (drained) path. Force-close path has
  // already broadcast phase4 with the same drain semantics.
  await setPhase("finalized")

  shutdownDrainAbortController = null
  // Release any upstream WS connections that survived the graceful path.
  // `closeAll()` is idempotent, so this is a no-op if Phase 4 already ran.
  // Without this, drain-success paths (Phase 2/3 drained) leave upstream
  // sockets dangling until process GC — wasting GHC-side connection quota.
  peekUpstreamWsManager()?.closeAll()

  // Close any remaining observer WS clients (no-op if Phase 4 already did).
  const remaining = deps.getWsClientCount()
  if (remaining > 0) {
    deps.closeWsClients()
    consola.info(`Disconnected ${remaining} WebSocket client(s) at finalize`)
  }

  tracker.destroy()
  // shutdownRequestTelemetry awaits the serialized persist chain in atomic-fs,
  // so any timer-fired or ad-hoc persist already enqueued runs to completion
  // before `.finally` resolves shutdownResolve. fire-and-forget is intentional:
  // a telemetry write failure must not block process exit.
  void shutdownRequestTelemetry().finally(() => {
    consola.info("Shutdown complete")
    shutdownResolve?.()
  })
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
    switch (shutdownPhase) {
      case "phase1": {
        // Phase 1 is fast synchronous setup — ignore duplicate signal, it will
        // proceed to phase2 momentarily. This commonly happens when bun --watch
        // forwards SIGINT to both parent and child processes.
        consola.warn("Signal received during Phase 1 setup, waiting for shutdown to proceed")
        return shutdownPromise ?? undefined
      }

      case "phase2": {
        consola.warn("Second signal received, escalating shutdown to abort active requests")
        shutdownDrainAbortController?.abort()
        return shutdownPromise ?? undefined
      }

      case "phase3": {
        consola.warn("Additional signal received, escalating shutdown to force-close remaining requests")
        shutdownDrainAbortController?.abort()
        return shutdownPromise ?? undefined
      }

      case "phase4": {
        // Force close is already in progress — user insists on immediate exit
        consola.warn("Additional signal received during forced shutdown, exiting immediately")
        exitFn(1)
        return shutdownPromise ?? undefined
      }

      case "finalized": {
        // Cleanup is already completing — ignore
        consola.info("Signal received after shutdown finalized, ignoring")
        return shutdownPromise ?? undefined
      }

      default: {
        // Should not happen, but guard exhaustively
        consola.warn("Signal received in unexpected shutdown phase, exiting immediately")
        exitFn(1)
        return shutdownPromise ?? undefined
      }
    }
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
    // Fire-and-forget: handleShutdownSignal manages its own error handling
    // and process.exit lifecycle. Errors thrown inside would already become
    // unhandled rejections — explicit `void` documents the intent.
    void handleShutdownSignal(signal)
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
  // Fresh, un-aborted controller so the next test starts clean. Tests MUST
  // ensure their in-flight streams have ended before resetting, otherwise a
  // stream holding the previous signal reference would never see an abort.
  shutdownAbortController = createShutdownController()
  shutdownDrainAbortController = null
  shutdownPhase = "idle"
  shutdownPromise = null
  serverInstance = null
}
