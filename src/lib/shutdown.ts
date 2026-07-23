/**
 * Centralized graceful shutdown management.
 *
 * One termination signal starts the complete four-step shutdown sequence:
 *   1. Stop accepting new work
 *   2. Wait for in-flight work to complete naturally
 *   3. Abort remaining work after the graceful deadline
 *   4. Force-close connections after the abort deadline
 * Persistence finalization follows those four request-lifecycle steps. A second
 * termination signal is a process-wide escape hatch and exits immediately; it
 * never advances the sequence one step at a time.
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
import { flushAndFreezePersistence as freezeNegotiation } from "./anthropic/feature-negotiation"
import {
  //
  getRequestContextManager,
  peekRequestContextManager,
} from "./context/manager"
import { getDiagnosticLogger } from "./diagnostics"
import { shutdownStructuredFileSink } from "./diagnostics/file"
import {
  //
  shutdownHistory,
  stopHistoryBackgroundWork,
} from "./history"
import { flushAndFreezePersistence as freezeCalibration } from "./models/calibration/engine"
import { peekUpstreamWsManager } from "./openai/upstream-ws"
import {
  //
  shutdownRequestTelemetry,
  stopTelemetryBackgroundWork,
} from "./request-telemetry"
import { notifyStopping } from "./restart/notify"
import { state } from "./state"
import { peekTokenRuntime } from "./token"
import { closeHttp2Sessions } from "./transport/http2-client"
import { emergencyWrite } from "./tui/terminal-coordinator"
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

export type ProcessLifecycleState = "idle" | "stopping" | "draining" | "aborting" | "forcing" | "finalizing" | "notifying" | "stopped" | "failed"

function createCompletionLatch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let shutdownCompletion = createCompletionLatch()

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
let shutdownPhase: ProcessLifecycleState = "idle"
let shutdownPromise: Promise<void> | null = null
let signalHandlers: { sigint: () => void; sigterm: () => void; sigusr2: () => void } | null = null

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
 * Map the detailed process state to the stable bus taxonomy. `finalizing` is
 * deliberately not mapped: `finalized` is published only after History and
 * Telemetry have both finished, so dashboards never report completion while
 * persistence is still draining.
 */
function toBusPhase(p: typeof shutdownPhase): ShutdownPhase | null {
  switch (p) {
    case "stopping":
    case "draining": {
      return "draining"
    }
    case "aborting":
    case "forcing": {
      return "aborting"
    }
    case "notifying":
    case "stopped": {
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
  if (!newBusPhase || newBusPhase === prevBusPhase || !_shutdownPublisher) {
    return Promise.resolve({ stillBuffering: 0 })
  }
  return _shutdownPublisher
    .publishAndFlush({
      kind: "system.shutdown_phase_changed",
      phase: newBusPhase,
      previousPhase: prevBusPhase,
      needsFlush: true,
    })
    .then((res) => {
      if (res.failures?.length)
        throw new AggregateError(
          res.failures.map((failure) => failure.error),
          `Shutdown phase ${newBusPhase} notification failed`,
        )
      return { stillBuffering: res.pendingWsBuffer }
    })
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
  return shutdownCompletion.promise
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
  /** Generation observability finalization barrier. Production uses the request manager registry. */
  drainModelOperationFinalizationsFn?: () => Promise<void>
  /** Persistence seams used by lifecycle tests. Production uses the real stores. */
  shutdownHistoryFn?: () => Promise<void>
  shutdownRequestTelemetryFn?: () => Promise<void>
  shutdownDiagnosticLoggingFn?: () => Promise<void>
  /** Test seam for the final completion notification barrier. */
  publishStoppedFn?: () => Promise<void>
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
  if (shutdownPhase === "stopped") return
  if (shutdownPhase !== "idle" && shutdownPhase !== "stopping") return shutdownCompletion.promise

  const tracker: ShutdownDrainSource = deps?.tracker ?? {
    // Drain waits on the OPERATION/finalization registry, not the visible logical-settle registry.
    // A settled request remains here through orphan settle-before work (fetch/backoff/response pump),
    // delivery notification, immutable canonical seal, and terminal publish. Phase 2/3 remain bounded;
    // the explicit finalization barrier below surfaces seal rejection before History closes.
    getActive: () => getRequestContextManager().getTrackedOperations(),
  }
  const server = deps?.server ?? serverInstance
  const rateLimiter = deps?.rateLimiter !== undefined ? deps.rateLimiter : getAdaptiveRateLimiter()
  const stopRefresh = deps?.stopTokenRefreshFn ?? (() => void peekTokenRuntime()?.dispose())
  const closeWsClients = deps?.closeAllClientsFn ?? closeAllClients
  const getWsClientCount = deps?.getClientCountFn ?? getClientCount
  const drainModelOperationFinalizations =
    deps?.drainModelOperationFinalizationsFn ?? (() => peekRequestContextManager()?.drainModelOperationFinalizations() ?? Promise.resolve())
  const closeHistory = deps?.shutdownHistoryFn ?? shutdownHistory
  const closeTelemetry = deps?.shutdownRequestTelemetryFn ?? shutdownRequestTelemetry
  const closeDiagnostics = deps?.shutdownDiagnosticLoggingFn ?? shutdownStructuredFileSink
  const publishStopped =
    deps?.publishStoppedFn
    ?? (() => {
      const previousPhase = toBusPhase("finalizing")
      if (!_shutdownPublisher) return Promise.resolve()
      return _shutdownPublisher
        .publishAndFlush({
          kind: "system.shutdown_phase_changed",
          phase: "finalized",
          previousPhase,
          needsFlush: true,
        })
        .then((result) => {
          if (result.failures?.length)
            throw new AggregateError(
              result.failures.map((failure) => failure.error),
              "Shutdown completion notification failed",
            )
        })
    })

  // Timing (defaults to state values from config, overridable for testing)
  const gracefulWaitMs = deps?.gracefulWaitMs ?? state.shutdownGracefulWait * 1000
  const abortWaitMs = deps?.abortWaitMs ?? state.shutdownAbortWait * 1000
  const drainOpts = {
    pollIntervalMs: deps?.drainPollIntervalMs ?? DRAIN_POLL_INTERVAL_MS,
    progressIntervalMs: deps?.drainProgressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS,
  }

  // ── Step 1: Stop accepting new requests ───────────────────────────────
  _isShuttingDown = true
  // NOTE: do NOT recreate shutdownAbortController here. It is created eagerly at
  // module load and reused for the whole process lifetime, so requests that
  // began (and possibly blocked on a stalled upstream) BEFORE this point already
  // hold its signal in their abort race and will observe the Phase 3 abort.
  // Fire-and-forget: Steps 1–3 do not immediately force-close observer sockets.
  // The force-close boundary and final completion notification are awaited.
  setPhaseFireAndForget("stopping")

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
  stopTelemetryBackgroundWork() // 停 telemetry rollup timer，避免与接管的新进程并发上卷（lifecycle.md overlap ②）
  closeHttp2Sessions()
  peekUpstreamWsManager()?.stopNew()

  // 通知 supervisor 正在收尾（systemd STOPPING=1；非 systemd no-op）
  notifyStopping()

  // states.json flush-then-freeze —— 仅 handoff（有后继者接管学习）才做；普通关机无后继者、无需 freeze
  // （且普通关机 freeze 会污染测试里 28+ 处 gracefulShutdown("SIGINT"/"SIGTERM")——R2 BLOCKER-NEW-1）。
  if (signal === "SIGUSR2") {
    await Promise.allSettled([freezeNegotiation(), freezeCalibration()])
  }

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

  // ── Step 2: Wait for natural completion ───────────────────────────────
  const activeCount = tracker.getActive().length
  if (activeCount > 0) {
    consola.info(`Step 2/4: Waiting up to ${gracefulWaitMs / 1000}s for ${activeCount} active request(s)...`)
    setPhaseFireAndForget("draining")
    shutdownDrainAbortController = new AbortController()

    try {
      const phase2Result = await drainActiveRequests(gracefulWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase2Result === "drained") {
        consola.info("All requests completed naturally")
        await finalize({ closeWsClients, getWsClientCount, drainModelOperationFinalizations, closeHistory, closeTelemetry, closeDiagnostics, publishStopped })
        return
      }
    } catch (error) {
      consola.error("Error during Step 2 drain:", error)
    }

    // ── Step 3: Abort signal + extended wait ──────────────────────────────
    const remaining = tracker.getActive().length
    consola.info(`Step 3/4: Sending abort signal to ${remaining} remaining request(s), ` + `waiting up to ${abortWaitMs / 1000}s...`)

    setPhaseFireAndForget("aborting")
    shutdownDrainAbortController = new AbortController()
    shutdownAbortController.abort()

    try {
      const phase3Result = await drainActiveRequests(abortWaitMs, tracker, {
        ...drainOpts,
        abortSignal: shutdownDrainAbortController.signal,
      })
      if (phase3Result === "drained") {
        consola.info("All requests completed after abort signal")
        await finalize({ closeWsClients, getWsClientCount, drainModelOperationFinalizations, closeHistory, closeTelemetry, closeDiagnostics, publishStopped })
        return
      }
    } catch (error) {
      consola.error("Error during Step 3 drain:", error)
    }

    // ── Step 4: Force close ──────────────────────────────────────────────
    // setPhase resolves once the broadcast frame has actually drained on every
    // status-subscribed WS client (or its internal deadline elapses). Awaiting
    // here means the dashboard is guaranteed to see "phase4" before we yank
    // the sockets in the next step.
    try {
      await setPhase("forcing")
    } catch (error) {
      writeEmergencyNoThrow(`[shutdown] Force-close phase notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const forceRemaining = tracker.getActive().length
    consola.warn(`Step 4/4: Force-closing ${forceRemaining} remaining request(s)`)

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

  await finalize({ closeWsClients, getWsClientCount, drainModelOperationFinalizations, closeHistory, closeTelemetry, closeDiagnostics, publishStopped })
}

interface FinalizeDeps {
  closeWsClients: () => void
  getWsClientCount: () => number
  drainModelOperationFinalizations: () => Promise<void>
  closeHistory: () => Promise<void>
  closeTelemetry: () => Promise<void>
  closeDiagnostics: () => Promise<void>
  publishStopped: () => Promise<void>
}

/** Final cleanup after drain/force-close */
async function finalize(deps: FinalizeDeps): Promise<void> {
  setPhaseFireAndForget("finalizing")
  shutdownDrainAbortController = null
  writeEmergencyNoThrow("[shutdown] Requests settled; flushing History and Telemetry. Press Ctrl+C again to exit immediately")

  const failures: Array<unknown> = []

  // Canonical terminal creation/publish is a pre-History durability barrier. The normal request
  // drain retains contexts until this settles, while this explicit join surfaces any rejection
  // instead of letting shutdown report success after a failed immutable seal.
  try {
    await deps.drainModelOperationFinalizations()
  } catch (error) {
    failures.push(error)
    consola.error("Generation finalization shutdown barrier failed:", error)
  }

  // Drain in-flight async finalizes, then close History (I4). This runs after
  // request drain on every normal exit path. The second-signal escape hatch can
  // still terminate this wait immediately without routing through persistence.
  try {
    await deps.closeHistory()
  } catch (error) {
    failures.push(error)
    consola.error("History shutdown failed:", error)
  }

  // Telemetry is part of lifecycle completion, not detached background work.
  // Awaiting it makes `stopped` and `waitForShutdown()` truthful.
  try {
    await deps.closeTelemetry()
  } catch (error) {
    failures.push(error)
    consola.error("Telemetry shutdown failed:", error)
  }

  // Record the pre-close verdict while the diagnostic writer is still live.
  // This does not claim the diagnostic barrier itself succeeded; the sink adds
  // its own sealing marker and only returns after write completion + fsync.
  if (failures.length === 0) getDiagnosticLogger().info("shutdown.persistence-ready", "History and telemetry barriers completed")
  else getDiagnosticLogger().error("shutdown.persistence-failed", "One or more persistence barriers failed", { failureCount: failures.length }, failures[0])

  // Diagnostic artifacts are part of truthful shutdown completion. Execute
  // this barrier even after another persistence failure so those diagnostics
  // are still given a chance to reach disk.
  try {
    await deps.closeDiagnostics()
  } catch (error) {
    failures.push(error)
    writeEmergencyNoThrow(`[shutdown] Diagnostic logging shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Release any upstream WS connections that survived the graceful path.
  // `closeAll()` is idempotent, so this is a no-op if Phase 4 already ran.
  // Without this, drain-success paths (Phase 2/3 drained) leave upstream
  // sockets dangling until process GC — wasting GHC-side connection quota.
  peekUpstreamWsManager()?.closeAll()

  // Publish the truthful terminal outcome while observer clients are still
  // connected. Diagnostic close has already returned, so completed means every
  // durability barrier succeeded. Failure is a distinct event, never a
  // finalized-then-rollback sequence.
  shutdownPhase = "notifying"
  if (failures.length === 0) {
    try {
      await deps.publishStopped()
    } catch (error) {
      failures.push(error)
      writeEmergencyNoThrow(`[shutdown] Completion notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0 && _shutdownPublisher) {
    try {
      const result = await _shutdownPublisher.publishAndFlush({
        kind: "system.shutdown_failed",
        errors: failures.map((error) => ({
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        })),
      })
      if (result.failures?.length)
        writeEmergencyNoThrow(`[shutdown] ${result.failures.length} observer(s) failed while receiving the shutdown failure terminal`)
    } catch (error) {
      failures.push(error)
      writeEmergencyNoThrow(`[shutdown] Failure notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Close any remaining observer WS clients (no-op if Step 4 already did).
  const remaining = deps.getWsClientCount()
  if (remaining > 0) {
    deps.closeWsClients()
    consola.info(`Disconnected ${remaining} WebSocket client(s) at finalize`)
  }

  if (failures.length > 0) {
    shutdownPhase = "failed"
    throw new AggregateError(failures, "Shutdown persistence failed")
  }

  shutdownPhase = "stopped"
  consola.info("Shutdown complete")
  shutdownCompletion.resolve()
}

// ============================================================================
// Signal handlers
// ============================================================================

interface HandleShutdownSignalOptions {
  gracefulShutdownFn?: (signal: string) => Promise<void>
  exitFn?: (code: number) => void
}

function forcedExitCode(signal: string): number {
  return signal === "SIGTERM" ? 143 : 130
}

/** Critical signal feedback is best-effort; it must never prevent exit. */
function writeEmergencyNoThrow(message: string): void {
  try {
    emergencyWrite(message)
  } catch {
    // The terminal owner itself is broken. Do not recurse into consola or the
    // observability bus here; the caller must continue to its lifecycle action.
  }
}

export function handleShutdownSignal(signal: string, opts?: HandleShutdownSignalOptions): Promise<void> | undefined {
  const shutdownFn = opts?.gracefulShutdownFn ?? ((shutdownSignal: string) => gracefulShutdown(shutdownSignal))
  const exitFn = opts?.exitFn ?? ((code: number) => process.exit(code))

  if (shutdownPhase === "stopped") return shutdownPromise ?? shutdownCompletion.promise

  if (shutdownPhase !== "idle") {
    // Deliberately bypass consola → observability bus → FileSink → History. The
    // escape hatch must remain visible and must not wait for any subsystem it is
    // intended to escape from.
    writeEmergencyNoThrow(`[shutdown] Second termination signal (${signal}); exiting immediately`)
    exitFn(forcedExitCode(signal))
    return shutdownPromise ?? undefined
  }

  // Claim the lifecycle synchronously before invoking the async task. This
  // closes the old idle/phase1 race: a second signal arriving immediately after
  // the first is always recognized as the force-exit signal.
  _isShuttingDown = true
  setPhaseFireAndForget("stopping")
  writeEmergencyNoThrow(`[shutdown] Received ${signal}; graceful shutdown started. Press Ctrl+C again to exit immediately`)

  shutdownPromise = shutdownFn(signal).catch((error: unknown) => {
    writeEmergencyNoThrow(`[shutdown] Fatal error during shutdown: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    shutdownPhase = "failed"
    exitFn(1)
  })
  return shutdownPromise
}

/** Setup process signal handlers for graceful shutdown */
export function setupShutdownHandlers(opts?: HandleShutdownSignalOptions): void {
  if (signalHandlers) return
  const handler = (signal: string) => {
    // Fire-and-forget: handleShutdownSignal manages its own error handling
    // and process.exit lifecycle. Errors thrown inside would already become
    // unhandled rejections — explicit `void` documents the intent.
    void handleShutdownSignal(signal, opts)
  }
  const sigint = () => handler("SIGINT")
  const sigterm = () => handler("SIGTERM")
  // 优雅重启交接信号：与 SIGTERM 同款 drain，仅日志标签区分（lifecycle.md「优雅重启」）。
  // 三环境共用（裸手动=新进程自发、systemd/pm2=脚本/supervisor 发）。
  const sigusr2 = () => handler("SIGUSR2")
  signalHandlers = { sigint, sigterm, sigusr2 }
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)
  process.on("SIGUSR2", sigusr2)
}

// ============================================================================
// Testing utilities
// ============================================================================

/** Reset module state (for tests only) */
export function _resetShutdownState(): void {
  _isShuttingDown = false
  shutdownCompletion = createCompletionLatch()
  // Fresh, un-aborted controller so the next test starts clean. Tests MUST
  // ensure their in-flight streams have ended before resetting, otherwise a
  // stream holding the previous signal reference would never see an abort.
  shutdownAbortController = createShutdownController()
  shutdownDrainAbortController = null
  shutdownPhase = "idle"
  shutdownPromise = null
  serverInstance = null
  _shutdownPublisher = undefined
  if (signalHandlers) {
    process.removeListener("SIGINT", signalHandlers.sigint)
    process.removeListener("SIGTERM", signalHandlers.sigterm)
    process.removeListener("SIGUSR2", signalHandlers.sigusr2)
    signalHandlers = null
  }
}
