/**
 * Telemetry runtime — the composition root for the request-telemetry lifecycle.
 *
 * Unlike the token runtime (which OWNS its manager instances), the telemetry
 * registry's runtime state — the persist/rollup timers, the open `telemetry.db`
 * handle, the in-memory 7d accumulators — is module-local in `request-telemetry.ts`
 * and naturally a process singleton. The `TelemetryRuntime` is therefore a thin
 * facade over those module functions; what the composition root actually injects is
 * the CONFIG SOURCE (a live {@link TelemetryConfigView} + change subscription + paths)
 * via the ambient {@link installTelemetryDeps} port, replacing the registry's direct
 * `~/lib/state` / `~/lib/config/paths` reads. Telemetry OWNS no config — its SoT stays
 * in core-config; the registry is a read-only consumer (no SoT reversal, unlike token).
 *
 * peek/get tolerance layering: the composition root (`start.ts`) constructs with
 * fail-fast {@link getTelemetryRuntime}; request/shutdown/route consumers read the
 * tolerant {@link peekTelemetryRuntime}`?.op()` (init-before no-op is semantically
 * correct and must not force every HTTP test to assemble a dummy runtime).
 */

import type { ThinkingBlockCounts } from "./dimension-names"
import type {
  //
  DimensionBreakdownSnapshot,
  RequestTelemetrySnapshot,
} from "./request-telemetry"
import type { TelemetryDatabase } from "./telemetry/db"

import {
  //
  installTelemetryDeps,
  type TelemetryRuntimeDependencies,
} from "./dependencies"
import {
  //
  getDimensionBreakdown,
  getRequestTelemetrySnapshot,
  getTelemetryDb,
  getThinkingBlockTotals,
  initRequestTelemetry,
  persistRequestTelemetry,
  recordAcceptedRequest,
  recordSettledRequest,
  runTelemetryJsonBackfill,
  shutdownRequestTelemetry,
  stopTelemetryBackgroundWork,
} from "./request-telemetry"

/** The settled-request measure inputs (the internal `SettledTelemetryInput` shape). */
type SettledTelemetryInput = Parameters<typeof recordSettledRequest>[1]

/**
 * The telemetry domain's single owner of the request-telemetry lifecycle — the 5-phase
 * contract (see the peel plan §3.2): ① initialize (listen-before), ② runJsonBackfill
 * (listen-after), ③ stopBackgroundWork (restart Phase-1), ④ dispose (final shutdown),
 * ⑤ reset (test). Request/shutdown/route consumers operate on ONE runtime instance
 * rather than reaching a module-global directly.
 *
 * **The runtime OWNS the phase ordering, rather than trusting the caller to keep it.** The startup
 * contract — initialize completes before the server listens, the legacy-JSON backfill runs after —
 * used to live only in the order of statements in `start.ts`, guarded from the outside by parsing
 * that file. Six rounds of adversarial review showed that a source-order guard can approximate
 * reachability but never prove it. So the invariant moved inside: {@link markServerListening}
 * fail-fasts if initialize never ran, and {@link runJsonBackfill} called too early is DEFERRED until
 * the listening mark instead of running at the wrong time. Reordering the calls in `start.ts` can no
 * longer break the contract, which is a stronger guarantee than any guard over the call site.
 */
export interface TelemetryRuntime {
  /** ① Rebuild the in-memory 7d window from SQLite + freeze `effectiveSketchGamma` + stash the pre-startup legacy-JSON snapshot. Runs BEFORE the server listens. */
  initialize(): Promise<void>
  /**
   * The server is now accepting connections — phase ① is over. Fail-fasts when {@link initialize}
   * never ran: serving requests against an unbuilt 7d window and an unfrozen sketch γ is a wiring
   * bug, not a degraded mode. Drains a {@link runJsonBackfill} that arrived early. Idempotent.
   */
  markServerListening(): void
  /**
   * ② Absorb the frozen legacy-JSON snapshot into telemetry.db. Must run AFTER the server listens
   * (non-blocking; structurally disjoint from post-startup tel_raw writes) — so if it is called
   * before {@link markServerListening}, it is DEFERRED to that moment rather than run early. The
   * ordering is therefore enforced here, not by the caller's statement order.
   */
  runJsonBackfill(now?: number): void
  /** Record one accepted (pre-dispatch) request into the sparkline + accepted leg. */
  recordAccepted(timestamp?: number): void
  /** Record one settled request across every resolved dimension key. */
  recordSettled(keys: Record<string, string | Array<string> | null>, opts: SettledTelemetryInput, cappedDimensions?: ReadonlySet<string>): void
  /** The `/api/status` back-compat model snapshot (accepted sparkline + per-model 7d series). */
  getSnapshot(now?: number): RequestTelemetrySnapshot
  /** The `/api/stats` + `/metrics` generic per-dimension breakdown. */
  getDimensionBreakdown(dimension: string, window?: "sinceStart" | "7d", limit?: number, now?: number): DimensionBreakdownSnapshot
  /** The open telemetry.db handle (null when disabled / unopened) — the SQLite-tier read path for `/api/stats`. */
  getTelemetryDb(): TelemetryDatabase | null
  /** The `/api/status` global thinking-block emptiness totals (single-sourced from the telemetry measures). */
  getThinkingBlockTotals(): ThinkingBlockCounts
  /** Drain the dual-write outbox into telemetry.db (the periodic flush + ad-hoc flush). */
  persist(): Promise<void>
  /** ③ Phase-1 stop: halt persist/rollup timers + unsubscribe config listener, WITHOUT flushing (idempotent). */
  stopBackgroundWork(): void
  /** ④ Final shutdown: unsubscribe → flush await → close db (drain-before-close ordering). */
  dispose(): Promise<void>
}

/**
 * The facade over the module-local request-telemetry singleton. Every method delegates
 * to the corresponding free function; the runtime carries no state of its own (the
 * registry's state is module-local by construction — see the module doc above).
 */
class TelemetryRuntimeImpl implements TelemetryRuntime {
  /** Phase ① completed — `markServerListening` refuses to proceed without it. */
  private initialized = false
  /** Phase ② is unblocked once the server accepts connections. */
  private listening = false
  /** A `runJsonBackfill(now)` that arrived before the listening mark, held until it is safe to run. */
  private deferredBackfillAt: number | undefined | "none" = "none"

  async initialize(): Promise<void> {
    await initRequestTelemetry()
    this.initialized = true
  }
  markServerListening(): void {
    if (!this.initialized) {
      throw new Error(
        "Telemetry runtime: the server is listening but initialize() never completed — requests would settle against an unbuilt 7d window and an unfrozen sketch γ. Call initialize() before starting the server.",
      )
    }
    if (this.listening) return
    this.listening = true
    if (this.deferredBackfillAt !== "none") {
      const now = this.deferredBackfillAt
      // Clearing first is defensive only: single-shot absorption is already guaranteed downstream
      // (the registry consumes its pending snapshot and trips a `json_backfill_version` guard), so
      // no test can observe this line — it exists so the runtime does not hold a stale timestamp.
      this.deferredBackfillAt = "none"
      runTelemetryJsonBackfill(now)
    }
  }
  runJsonBackfill(now?: number): void {
    // Called before the server listens: hold it rather than run it early. Absorbing the legacy JSON
    // while startup is still in flight is exactly what the post-listen placement exists to avoid.
    if (!this.listening) {
      this.deferredBackfillAt = now
      return
    }
    runTelemetryJsonBackfill(now)
  }
  recordAccepted(timestamp?: number): void {
    recordAcceptedRequest(timestamp)
  }
  recordSettled(keys: Record<string, string | Array<string> | null>, opts: SettledTelemetryInput, cappedDimensions?: ReadonlySet<string>): void {
    recordSettledRequest(keys, opts, cappedDimensions)
  }
  getSnapshot(now?: number): RequestTelemetrySnapshot {
    return getRequestTelemetrySnapshot(now)
  }
  getDimensionBreakdown(dimension: string, window?: "sinceStart" | "7d", limit?: number, now?: number): DimensionBreakdownSnapshot {
    return getDimensionBreakdown(dimension, window, limit, now)
  }
  getTelemetryDb(): TelemetryDatabase | null {
    return getTelemetryDb()
  }
  getThinkingBlockTotals(): ThinkingBlockCounts {
    return getThinkingBlockTotals()
  }
  persist(): Promise<void> {
    return persistRequestTelemetry()
  }
  stopBackgroundWork(): void {
    stopTelemetryBackgroundWork()
  }
  dispose(): Promise<void> {
    return shutdownRequestTelemetry()
  }
}

/**
 * Construct a telemetry runtime from its injected dependencies and install those
 * dependencies into the ambient port so the telemetry registry reads the same
 * config/paths source (replacing its direct core reads once T2 wires them).
 */
export function createTelemetryRuntime(deps: TelemetryRuntimeDependencies): TelemetryRuntime {
  installTelemetryDeps(deps)
  return new TelemetryRuntimeImpl()
}

// ============================================================================
// Process-singleton lifecycle
// ============================================================================

let installedRuntime: TelemetryRuntime | null = null

/**
 * Install the process-singleton telemetry runtime. Installing over a LIVE runtime
 * throws (prevents two owners) — the caller must `dispose()` the previous one first.
 * Tests clear it via {@link resetTelemetryRuntimeForTests}.
 */
export function installTelemetryRuntime(runtime: TelemetryRuntime): void {
  if (installedRuntime) {
    throw new Error("A telemetry runtime is already installed; dispose it before installing another")
  }
  installedRuntime = runtime
}

/**
 * Read the installed telemetry runtime, failing fast if none is installed (no silent
 * module-global fallback — an uninstalled runtime is a wiring bug). Used by the
 * composition root, which always assembles a runtime first.
 */
export function getTelemetryRuntime(): TelemetryRuntime {
  if (!installedRuntime) {
    throw new Error("Telemetry runtime not installed — call installTelemetryRuntime() from the composition root first")
  }
  return installedRuntime
}

/**
 * Read the installed runtime WITHOUT throwing (null if none). Used by the
 * request/shutdown/route consumers, whose pre-init no-op tolerance is semantically
 * correct and must not require every HTTP test to assemble a dummy runtime.
 */
export function peekTelemetryRuntime(): TelemetryRuntime | null {
  return installedRuntime
}

/**
 * Dispose the current runtime (final shutdown: stop timers + flush + close db) and clear
 * the singleton. The registry's module-local state hard-reset stays with
 * `_resetRequestTelemetryForTests` (a separate RESETTERS entry); this one only tears down
 * the runtime singleton so the next test's peek/get sees none. Idempotent (null-guarded).
 */
export async function resetTelemetryRuntimeForTests(): Promise<void> {
  await installedRuntime?.dispose()
  installedRuntime = null
}
