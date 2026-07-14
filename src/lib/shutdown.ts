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
import type { RequestContext } from "./context/request"
import type {
  //
  ScopedPublisher,
  ShutdownPhase,
} from "./observability"
import type { ServerInstance } from "./serve"

import { getAdaptiveRateLimiter } from "./adaptive-rate-limiter"
import { getRequestContextManager } from "./context/manager"
import {
  //
  shutdownHistory,
  stopHistoryBackgroundWork,
} from "./history"
import { peekUpstreamWsManager } from "./openai/upstream-ws"
import { shutdownRequestTelemetry } from "./request-telemetry"
import { state } from "./state"
import { stopTokenRefresh } from "./token"
import { closeHttp2Sessions } from "./transport/http2-client"
import {
  //
  closeAllClients,
  getClientCount,
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
 * Scoped publisher for `system.shutdown_phase_changed` events. Set once at
 * start.ts via `setShutdownPublisher(bus.scope('system'))`. When unset
 * (tests / early init), phase transitions are silent — the legacy WS
 * `notifyShutdownPhaseChangedAndFlush` direct broadcast is gone (commit 4),
 * so without a publisher there's no operator-visible signal but the
 * shutdown sequence still completes correctly.
 */
let _shutdownPublisher: ScopedPublisher<"system"> | undefined

export function setShutdownPublisher(publisher: ScopedPublisher<"system"> | undefined): void {
  _shutdownPublisher = publisher
}

/**
 * Map the internal phase enum (`phase1`/`phase2`/`phase3`/`phase4`/
 * `finalized`/`idle`) to the bus-visible ShutdownPhase enum
 * (`draining`/`aborting`/`finalized`) per RFC §2.3. WS clients receive
 * the simpler 3-state taxonomy; the internal 5-state remains for code
 * clarity (drain → drain-with-abort-signal → force-cleanup → finalize).
 */
function toBusPhase(p: typeof shutdownPhase): ShutdownPhase | null {
  switch (p) {
    case "phase1":
    case "phase2": {
      return "draining"
    }
    case "phase3":
    case "phase4": {
      return "aborting"
    }
    case "finalized": {
      return "finalized"
    }
    default: {
      return null
    }
  }
}

/**
 * Transition shutdown phase and publish to the observability bus. Returns
 * a promise that resolves once WsSink (and other async subscribers) have
 * drained the broadcast — `publishAndFlush` mirrors the legacy
 * `notifyShutdownPhaseChangedAndFlush` `stillBuffering` semantics via
 * `pendingWsBuffer`. Callers that are about to force-close sockets MUST
 * await this; normal phase progressions can fire-and-forget via
 * `setPhaseFireAndForget`.
 */
function setPhase(phase: typeof shutdownPhase): Promise<{ stillBuffering: number }> {
  const prev = shutdownPhase
  shutdownPhase = phase
  if (prev === phase) return Promise.resolve({ stillBuffering: 0 })
  const newBusPhase = toBusPhase(phase)
  const prevBusPhase = toBusPhase(prev)
  if (!newBusPhase || !_shutdownPublisher) {
    return Promise.resolve({ stillBuffering: 0 })
  }
  return _shutdownPublisher
    .publishAndFlush({
      kind: "system.shutdown_phase_changed",
      phase: newBusPhase,
      previousPhase: prevBusPhase,
      needsFlush: true,
    })
    .then((res) => ({ stillBuffering: res.pendingWsBuffer }))
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
  /**
   * Source of active RequestContexts for drain progress / count.
   * Production passes the RequestContextManager (via getRequestContextManager()).
   * Tests pass a controllable fake.
   */
  tracker?: ShutdownDrainSource
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
export function formatActiveRequestsSummary(requests: Array<RequestContext>): string {
  const now = Date.now()
  const lines = requests.map((req) => {
    const age = Math.round((now - req.startTime) / 1000)
    const model = req.resolvedModel ?? req.originalRequest?.model ?? "unknown"
    return `  ${req.method} ${req.path} ${model} (${req.state}, ${age}s)`
  })
  return `Waiting for ${requests.length} active request(s):\n${lines.join("\n")}`
}

/**
 * Wait for all active requests to complete, with periodic progress logging.
 * Returns "drained" when all requests finish, "timeout" if deadline is reached.
 */
/**
 * Drain interface — replaces the legacy `{ getActiveRequests: () =>
 * TuiLogEntry[] }` shape. Tracks active RequestContexts via the
 * RequestContextManager. Production passes the manager directly; tests
 * pass a controllable fake.
 */
export interface ShutdownDrainSource {
  getActive: () => Array<RequestContext>
}

export async function drainActiveRequests(
  timeoutMs: number,
  tracker: ShutdownDrainSource,
  opts?: { pollIntervalMs?: number; progressIntervalMs?: number; abortSignal?: AbortSignal },
): Promise<"drained" | "timeout" | "aborted"> {
  const pollInterval = opts?.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS
  const progressInterval = opts?.progressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS
  const abortSignal = opts?.abortSignal
  const deadline = Date.now() + timeoutMs
  let lastProgressLog = 0

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) return "aborted"

    const active = tracker.getActive()
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
  const tracker: ShutdownDrainSource = deps?.tracker ?? {
    // C5: drain waits on the OPERATION registry (quiesce), not just the visible registry (settle).
    // A settled-but-not-quiesced request keeps orphan settle-before work (fetch/backoff) that must
    // be drained. For an unwired ctx this equals getAll() (empties at settle), so current behavior
    // is preserved; it becomes meaningful once C4a wires `trackOperationBody` at the work sites.
    // Bounded by the existing Phase 2/3/4 timeouts (never waits forever); reaper/deadline still
    // settle immediately (cancel is decoupled from quiesce), so this never blocks settle.
    getActive: () => getRequestContextManager().getTrackedOperations(),
  }
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

  // Stop background services. History BACKGROUND work stops here (reaper /
  // backfill), but the DB stays OPEN through Phase 2/3 drain — a request settling
  // during drain triggers an async finalize that must still persist. The DB is
  // drained + closed later in finalize() (RFC history-finalize-async-offload §4.1).
  stopRefresh()
  stopHistoryBackgroundWork()
  closeHttp2Sessions()
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
  const activeCount = tracker.getActive().length
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
        await finalize({ closeWsClients, getWsClientCount })
        return
      }
    } catch (error) {
      consola.error("Error during Phase 2 drain:", error)
    }

    // ── Phase 3: Abort signal + extended wait ─────────────────────────────
    const remaining = tracker.getActive().length
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
        await finalize({ closeWsClients, getWsClientCount })
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
    const forceRemaining = tracker.getActive().length
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

  await finalize({ closeWsClients, getWsClientCount })
}

interface FinalizeDeps {
  closeWsClients: () => void
  getWsClientCount: () => number
}

/** Final cleanup after drain/force-close */
async function finalize(deps: FinalizeDeps): Promise<void> {
  // Await the broadcast drain so dashboards reliably see "finalized" before we
  // close their sockets in the graceful (drained) path. Force-close path has
  // already broadcast phase4 with the same drain semantics.
  await setPhase("finalized")

  shutdownDrainAbortController = null

  // Drain in-flight async finalizes, then close the history DB (I4). This runs
  // AFTER Phase 2/3 request drain on EVERY exit path (the choke point), so every
  // request that settled during drain has had its async finalize kicked; we await
  // those here so none writes to a closed DB / is lost. Never throws.
  await shutdownHistory()
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

  // (Legacy `tracker.destroy()` removed in commit 4 — ConsoleSink owns
  // stdout lifecycle now and is torn down by the Node process exit hook;
  // sinks holding subscriptions are unsubscribed when the bus singleton
  // is garbage-collected. No explicit destroy needed during shutdown.)
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
