/**
 * Centralized graceful shutdown management.
 *
 * SIGINT, SIGTERM, or SIGUSR2 received while idle stops ingress, losslessly
 * drains every accepted operation, and then closes runtime resources behind
 * durability barriers. Shutdown never cancels request work on a timer of its own.
 *
 * While the lifecycle is active, SIGUSR2 stays idempotent and SIGINT/SIGTERM escalate in two tiers:
 * the first such signal abandons the wait for REQUESTS (terminating them through request-level primitives) but still runs every durability barrier;
 * the next one is the immediate escape hatch. Once past the request drain — in `finalizing`/`notifying`/`failed` — the very next signal exits immediately, because there the thing being awaited is the persistence barrier itself.
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
 * Termination signals seen AFTER the lifecycle was claimed.
 * 0 while the first signal is still the only one; 1 selects the drain-abandonment tier; 2+ is the hard escape.
 * Counted separately from `shutdownPhase` because the tier depends on how many times the operator asked, not on how far shutdown has progressed.
 */
let postClaimTerminationSignals = 0

/**
 * The drain source the running `gracefulShutdown` is polling.
 * Published so the second termination signal can reach exactly the operations the drain is waiting on — including a test-injected fake — instead of rebuilding the production union and diverging from what the drain actually watches.
 */
let activeDrainSource: ShutdownDrainSource | null = null

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
  // Publish the source the drain is about to poll, so a second termination signal terminates exactly these operations rather than a separately-rebuilt union.
  activeDrainSource = tracker
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

  // Stop listening for new connections (but keep existing ones alive).
  // Do NOT await — server.close(false) stops accepting new connections immediately, but the returned promise won't resolve until all existing connections end.
  // Upgraded WebSocket connections (even after close handshake) keep the HTTP server open indefinitely, which would block the entire shutdown sequence.
  //
  // This sits immediately after the flag above, BEFORE any await, on purpose.
  // The flag makes the observability middleware answer 503; closing the listener is what stops the kernel handing us new connections at all.
  // Every await between the two is a window where we still accept connections only to reject them, and under SO_REUSEPORT during a `--restart` takeover the kernel is load-balancing new connections across us and the successor, so a share of them fail here instead of being served next door.
  // That window used to span `drainAdmissionHandoffs()` plus — on the handoff path specifically, which is exactly when a successor is competing for the port — the `freezeNegotiation`/`freezeCalibration` persistence I/O below. Neither is bounded: a process carrying a large History write backlog can sit in them for minutes, and while it does, it both rejects and keeps accepting.
  // That is the likely shape of the 2026-08-09 incident, where clients were still getting the shutdown 503 seven minutes into a handoff; see the note on that 503 in src/lib/observability/middleware.ts, which closes the other path the evidence permits (a client whose pooled socket already points here). The two fixes cover different mechanisms — neither makes the other redundant.
  // docs/lifecycle.md「优雅重启」specifies 旧进程立即停止 accept 新连接; this ordering is what makes "立即" true.
  if (server) {
    server.close(false).catch((error: unknown) => {
      consola.error("Error stopping listener:", error)
    })
    consola.info("Stopped accepting new connections")
  }

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
  // progress in the UI. They are torn down by `closeAllClients()` in finalize, once every accepted operation has drained, so the operator can observe the full shutdown timeline.
  // (This used to say they go down "in Phase 4 along with the HTTP server (force close)". There is no force close: `server.close(false)` above is the only `close` call in this file, and it deliberately leaves established connections alone.)

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

/**
 * Operator-requested drain abandonment — the second termination signal.
 *
 * Terminates every accepted generation operation through the SAME request-level primitives the stale reaper and `timeouts.request_deadline` already use: `reapInFlight()` cancels the in-flight upstream work, `fail()` records the terminal state with its provenance.
 * Shutdown still owns no deadline of its own; this runs only because a human explicitly gave up waiting, which is why the terminal is attributed to `shutdown`/`operator-abandoned-drain` rather than to a timeout.
 *
 * Each operation this DOES terminate stops holding the drain, so the drain loop can fall through to `finalize()` and History, Telemetry and Diagnostics still flush. That is the point of this tier: bounded by the operator, but not lossy.
 *
 * It is NOT a guarantee that the drain ends. Three shapes survive it, and the banner must not paper over them: an operation that is already settled but still finalizing (below); a lightweight operation (below); and the `stopping` awaits that run BEFORE the drain even starts (`drainAdmissionHandoffs`, the handoff freezes), where `activeDrainSource` is still null and there is nothing to reach. The third signal is the escape for all three.
 *
 * Scope limit — lightweight operations (count_tokens / embeddings) are NOT terminated here: `LightweightInFlightOperation` is a read-only descriptor with no cancellation surface. They are short by construction, and if one ever does wedge the drain the third signal remains the escape.
 *
 * @returns what this actually did, split so the operator banner cannot overstate it.
 */
function abandonDrain(signal: string): { started: boolean; terminated: number; finalizing: number; lightweight: number } {
  const source = activeDrainSource
  // The drain has not begun yet — we are still in the `stopping` awaits that precede it (admission handoff, freeze). There is nothing to abandon, and this tier cannot unblock those; say so rather than printing a count that implies we acted.
  if (!source) return { started: false, terminated: 0, finalizing: 0, lightweight: 0 }

  let terminated = 0
  let finalizing = 0
  let lightweight = 0
  for (const operation of source.getActive()) {
    // Same discriminator `formatActiveRequestsSummary` uses to tell the two registries apart. Counted, not just skipped: a lightweight operation still HOLDS the drain, so the banner has to be able to say what is keeping it open.
    if ("operationId" in operation) {
      lightweight++
      continue
    }
    try {
      // An operation can be settled and STILL tracked: `releaseTrackedOperationIfTerminal` is a deliberate no-op while `blocker !== "none"` (context/manager.ts), so the ctx stays visible instead of silently vanishing.
      // Two reasons to leave those alone. The count: `fail()` early-returns on them (`if (settled) return`), so counting one as terminated is simply false. The risk: `reapInFlight()` aborts `lifecycleAbort`, and while the canonical finalizer itself does NOT read that signal (it waits on `whenOperationQuiesced()`), the operation body, transport and delivery paths that may still be winding down DO consume it — aborting there can disturb work that is still trying to finish.
      if (operation.settled) {
        finalizing++
        continue
      }
      operation.reapInFlight()
      operation.fail(
        operation.resolvedModel ?? operation.originalRequest?.model ?? "unknown",
        new Error(`Drain abandoned by operator (${signal}) before this request completed`),
        undefined,
        { attribution: { category: "shutdown", code: "operator-abandoned-drain" } },
      )
      terminated++
    } catch (error) {
      // One wedged context must not stop us reaching the others — the operator asked to stop waiting, so best-effort is the correct shape here.
      consola.warn("[shutdown] could not terminate an operation while abandoning the drain:", error)
    }
  }
  return { started: true, terminated, finalizing, lightweight }
}

/**
 * Phrase the tier-2 outcome for the operator, WITHOUT overstating it.
 *
 * "I terminated your requests and I am flushing" is a promise, and it reads very differently at 3am from what actually happened. `now flushing` is therefore claimed ONLY when nothing is left holding the drain — otherwise the operator goes looking for a flush that has not started, or trusts a handoff that is still wedged.
 */
function describeDrainAbandonment(outcome: { started: boolean; terminated: number; finalizing: number; lightweight: number }): string {
  if (!outcome.started) {
    return "the drain has not started yet, so there is nothing to abandon — this phase is still stopping ingress and cannot be shortened by this signal."
  }

  const stillHolding: Array<string> = []
  if (outcome.finalizing > 0) stillHolding.push(`${outcome.finalizing} already-settled operation(s) still persisting`)
  if (outcome.lightweight > 0) stillHolding.push(`${outcome.lightweight} lightweight operation(s) that have no cancellation surface`)

  const terminatedNote = `abandoning the drain wait — terminated ${outcome.terminated} in-flight request(s)`
  if (stillHolding.length === 0) return `${terminatedNote}, now flushing.`
  // Deliberately does NOT say "now flushing": the drain is still held, so persistence has not begun. Both remaining shapes are ones this tier refuses to interrupt by design, which is exactly what the third signal is for.
  return `${terminatedNote}, but the drain is STILL HELD by ${stillHolding.join(" and ")} — not flushing yet.`
}

export function handleShutdownSignal(signal: string, opts?: HandleShutdownSignalOptions): Promise<void> | undefined {
  const shutdownFn = opts?.gracefulShutdownFn ?? ((shutdownSignal: string) => gracefulShutdown(shutdownSignal))
  const exitFn = opts?.exitFn ?? ((code: number) => process.exit(code))

  if (shutdownPhase === "stopped") return shutdownPromise ?? shutdownCompletion.promise

  if (shutdownPhase !== "idle") {
    if (!isTerminationSignal(signal)) return shutdownPromise ?? undefined

    postClaimTerminationSignals++

    // Tier 2 — the operator gives up waiting for the drain, but NOT on durability.
    // Terminate what is still in flight and let the drain loop fall through to finalize, so every persistence barrier still runs.
    // Deliberately scoped to the phases that are still WAITING ON REQUESTS: once we are in `finalizing`/`notifying`/`failed` the thing being waited on IS the persistence barrier, which is exactly what the escape hatch exists to escape — so there the second signal must still exit immediately, as it always has.
    const waitingOnRequests = shutdownPhase === "stopping" || shutdownPhase === "draining"
    if (waitingOnRequests && postClaimTerminationSignals === 1) {
      const outcome = abandonDrain(signal)
      writeEmergencyNoThrow(
        `[shutdown] Second termination signal (${signal}); ${describeDrainAbandonment(outcome)} Press Ctrl+C again to exit immediately WITHOUT flushing`,
      )
      return shutdownPromise ?? undefined
    }

    // Deliberately bypass consola → observability bus → FileSink → History. The
    // escape hatch must remain visible and must not wait for any subsystem it is
    // intended to escape from.
    writeEmergencyNoThrow(`[shutdown] Termination signal (${signal}) during ${shutdownPhase}; exiting immediately`)
    exitFn(forcedExitCode(signal))
    return shutdownPromise ?? undefined
  }

  // Claim the lifecycle synchronously before invoking the async task. This
  // closes the old idle/phase1 race: a second signal arriving immediately after
  // the first is always recognized as the force-exit signal.
  _isShuttingDown = true
  setPhaseFireAndForget("stopping")
  writeEmergencyNoThrow(
    `[shutdown] Received ${signal}; graceful shutdown started, waiting for accepted requests. Press Ctrl+C again to stop waiting and flush, or twice to exit immediately`,
  )

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
  postClaimTerminationSignals = 0
  activeDrainSource = null
  if (signalHandlers) {
    process.removeListener("SIGINT", signalHandlers.sigint)
    process.removeListener("SIGTERM", signalHandlers.sigterm)
    process.removeListener("SIGUSR2", signalHandlers.sigusr2)
    signalHandlers = null
  }
}
