/**
 * Centralized graceful shutdown management.
 *
 * SIGINT, SIGTERM, or SIGUSR2 received while idle stops ingress, losslessly
 * drains every accepted operation, and then closes runtime resources behind
 * durability barriers. Shutdown never cancels request work. While lifecycle is
 * active, SIGUSR2 is idempotent; SIGINT or SIGTERM is the immediate escape hatch.
 */

import { peekTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"
import consola from "consola"

import { peekTokenRuntime } from "~/lib/token"

import type { LightweightInFlightOperation } from "./context/lightweight-model-operation"
import type { RequestContext } from "./context/request"
import type {
  //
  ScopedPublisher,
  ShutdownPhase,
} from "./observability"
import type { ServerInstance } from "./serve"

import { flushAndFreezePersistence as freezeNegotiation } from "./anthropic/feature-negotiation"
import { listInFlightLightweightModelOperations } from "./context/lightweight-model-operation"
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
import {
  //
  drainHistoryAdmission,
  drainHistoryAdmissionHandoffs,
  stopHistoryAdmission,
} from "./history/worker/http-admission"
import { flushAndFreezePersistence as freezeCalibration } from "./models/calibration/engine"
import { peekUpstreamWsManager } from "./openai/upstream-ws"
import { notifyStopping } from "./restart/notify"
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

export type ProcessLifecycleState = "idle" | "stopping" | "draining" | "finalizing" | "notifying" | "stopped" | "failed"

function createCompletionLatch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let shutdownCompletion = createCompletionLatch()

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
   * Source of accepted generation and lightweight operations for drain progress.
   * Production combines the RequestContextManager with the lightweight in-flight registry.
   * Tests may pass a controllable fake.
   */
  tracker?: ShutdownDrainSource
  server?: {
    close: (force?: boolean) => Promise<void>
  }
  /** Close the token runtime after every accepted operation has quiesced. */
  closeTokenRuntimeFn?: () => Promise<void>
  closeAllClientsFn?: () => void
  getClientCountFn?: () => number
  /** Request context manager (for stopping stale reaper during shutdown) */
  contextManager?: { stopReaper: () => void }
  /** Generation observability finalization barrier. Production uses the request manager registry. */
  drainModelOperationFinalizationsFn?: () => Promise<void>
  /** Stop pre-context History admission and reject queued operations in Step 1. */
  stopHistoryAdmissionFn?: (error: Error) => void
  /** Wait until every granted reservation has either bound to a visible operation or released. */
  drainHistoryAdmissionHandoffsFn?: () => Promise<void>
  /** Wait for admitted History operations to reach terminal persistence outcomes. */
  drainHistoryAdmissionFn?: () => Promise<void>
  /** Persistence seams used by lifecycle tests. Production uses the real stores. */
  shutdownHistoryFn?: () => Promise<void>
  shutdownRequestTelemetryFn?: () => Promise<void>
  shutdownDiagnosticLoggingFn?: () => Promise<void>
  /** Test seam for the final completion notification barrier. */
  publishStoppedFn?: () => Promise<void>
  /** Poll timing overrides for deterministic tests. */
  drainPollIntervalMs?: number
  drainProgressIntervalMs?: number
}

// ============================================================================
// Drain logic
// ============================================================================

export type ShutdownActiveOperation = RequestContext | LightweightInFlightOperation

/** Format a summary of accepted operations for logging. */
export function formatActiveRequestsSummary(requests: Array<ShutdownActiveOperation>): string {
  const now = Date.now()
  const lines = requests.map((request) => {
    const age = Math.round((now - request.startTime) / 1000)
    if ("operationId" in request) {
      return `  ${request.method} ${request.path} ${request.requestedModel ?? "unknown"} (${request.kind}, ${age}s)`
    }
    const model = request.resolvedModel ?? request.originalRequest?.model ?? "unknown"
    return `  ${request.method} ${request.path} ${model} (${request.state}, ${age}s)`
  })
  return `Waiting for ${requests.length} accepted operation(s):\n${lines.join("\n")}`
}

/**
 * Wait for all accepted operations to complete, with periodic progress logging.
 * Shutdown owns no drain deadline; only request-level mechanisms may terminate work.
 */
/** Drain source shared by the production registry union and controllable test fakes. */
export interface ShutdownDrainSource {
  getActive: () => Array<ShutdownActiveOperation>
}

export async function drainActiveRequests(tracker: ShutdownDrainSource, opts?: { pollIntervalMs?: number; progressIntervalMs?: number }): Promise<void> {
  const pollInterval = opts?.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS
  const progressInterval = opts?.progressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS
  let lastProgressLog = 0

  for (;;) {
    const active = tracker.getActive()
    if (active.length === 0) return

    const now = Date.now()
    if (now - lastProgressLog >= progressInterval) {
      lastProgressLog = now
      consola.info(formatActiveRequestsSummary(active))
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval))
  }
}

// ============================================================================
// Graceful shutdown
// ============================================================================

/**
 * Stop ingress, drain accepted operations, and finalize runtime resources.
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
    getActive: () => [...getRequestContextManager().getTrackedOperations(), ...listInFlightLightweightModelOperations()],
  }
  const server = deps?.server ?? serverInstance
  const closeTokenRuntime = deps?.closeTokenRuntimeFn ?? (async () => await peekTokenRuntime()?.dispose())
  const closeWsClients = deps?.closeAllClientsFn ?? closeAllClients
  const getWsClientCount = deps?.getClientCountFn ?? getClientCount
  // NOTE (Task 4 / Task 6 seam): the manager method this calls was renamed
  // `drainModelOperationFinalizations` → `drainLifecycleFailures` in Task 4 (manager.ts). The
  // `ShutdownDeps.drainModelOperationFinalizationsFn` field name, this local variable, and the
  // `FinalizeDeps.drainModelOperationFinalizations` field below are Task 6's responsibility
  // (plan: `Modify: src/lib/shutdown.ts` — dependency rename — Task 6 Step 3/5) and are left
  // unchanged here; only the call target is updated so `bun run typecheck` passes for Task 4.
  const drainModelOperationFinalizations =
    deps?.drainModelOperationFinalizationsFn ?? (() => peekRequestContextManager()?.drainLifecycleFailures() ?? Promise.resolve())
  const stopAdmission = deps?.stopHistoryAdmissionFn ?? stopHistoryAdmission
  const drainAdmissionHandoffs = deps?.drainHistoryAdmissionHandoffsFn ?? drainHistoryAdmissionHandoffs
  const drainAdmission = deps?.drainHistoryAdmissionFn ?? drainHistoryAdmission
  const closeHistory = deps?.shutdownHistoryFn ?? shutdownHistory
  const closeTelemetry = deps?.shutdownRequestTelemetryFn ?? (async () => await peekTelemetryRuntime()?.dispose())
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

  const drainOpts = {
    pollIntervalMs: deps?.drainPollIntervalMs ?? DRAIN_POLL_INTERVAL_MS,
    progressIntervalMs: deps?.drainProgressIntervalMs ?? DRAIN_PROGRESS_INTERVAL_MS,
  }

  // ── Step 1: Stop accepting new requests ───────────────────────────────
  _isShuttingDown = true
  // Reject only pre-context admission waiters. Already accepted operations own
  // bound reservations and continue losslessly through the operation registry.
  stopAdmission(new Error(`History admission stopped by ${signal}`))
  // Close the acquire→bind/release handoff before the first operation-registry
  // snapshot. When this resolves, every granted reservation is either released or
  // bound to an operation already visible to the lossless drain oracle.
  await drainAdmissionHandoffs()
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

  // Stop maintenance producers, but keep every request dependency live until the
  // accepted-operation registry drains. In-flight work may still need a token refresh,
  // a rate-limit permit, or a NEW upstream WS/h2 connection after this point.
  stopHistoryBackgroundWork()
  peekTelemetryRuntime()?.stopBackgroundWork() // 停 telemetry rollup timer，避免与接管的新进程并发上卷（lifecycle.md overlap ②）

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

  // ── Step 2: Losslessly drain accepted operations ─────────────────────
  const activeCount = tracker.getActive().length
  if (activeCount > 0) consola.info(`Waiting for ${activeCount} accepted request(s) to finish...`)
  setPhaseFireAndForget("draining")
  await drainActiveRequests(tracker, drainOpts)
  if (activeCount > 0) consola.info("All accepted requests completed")

  await finalize({
    closeTokenRuntime,
    closeWsClients,
    getWsClientCount,
    drainModelOperationFinalizations,
    drainHistoryAdmission: drainAdmission,
    closeHistory,
    closeTelemetry,
    closeDiagnostics,
    publishStopped,
  })
}

interface FinalizeDeps {
  closeTokenRuntime: () => Promise<void>
  closeWsClients: () => void
  getWsClientCount: () => number
  drainModelOperationFinalizations: () => Promise<void>
  drainHistoryAdmission: () => Promise<void>
  closeHistory: () => Promise<void>
  closeTelemetry: () => Promise<void>
  closeDiagnostics: () => Promise<void>
  publishStopped: () => Promise<void>
}

/** Final cleanup after every accepted operation has drained. */
async function finalize(deps: FinalizeDeps): Promise<void> {
  setPhaseFireAndForget("finalizing")
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

  try {
    await deps.drainHistoryAdmission()
  } catch (error) {
    failures.push(error)
    consola.error("History admission shutdown barrier failed:", error)
  }

  // Token refresh and retry remain available throughout request drain. Dispose the
  // runtime only after every accepted operation and canonical finalizer has settled.
  try {
    await deps.closeTokenRuntime()
  } catch (error) {
    failures.push(error)
    consola.error("Token runtime shutdown failed:", error)
  }

  // No accepted operation remains, so upstream transports can now be released.
  peekUpstreamWsManager()?.closeAll()
  closeHttp2Sessions()

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

type TerminationSignal = "SIGINT" | "SIGTERM"

function isTerminationSignal(signal: string): signal is TerminationSignal {
  return signal === "SIGINT" || signal === "SIGTERM"
}

function forcedExitCode(signal: TerminationSignal): number {
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
    if (!isTerminationSignal(signal)) return shutdownPromise ?? undefined

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
