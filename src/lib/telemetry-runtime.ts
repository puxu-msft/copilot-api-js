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

import type {
  //
  DimensionBreakdownSnapshot,
  RequestTelemetrySnapshot,
} from "./request-telemetry"
import type { ThinkingBlockCounts } from "./telemetry-dimension-names"
import type { TelemetryDatabase } from "./telemetry/db"

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
import {
  //
  installTelemetryDeps,
  type TelemetryRuntimeDependencies,
} from "./telemetry-dependencies"

/** The settled-request measure inputs (the internal `SettledTelemetryInput` shape). */
type SettledTelemetryInput = Parameters<typeof recordSettledRequest>[1]

/**
 * The telemetry domain's single owner of the request-telemetry lifecycle — the 5-phase
 * contract (see the peel plan §3.2): ① initialize (listen-before), ② runJsonBackfill
 * (listen-after), ③ stopBackgroundWork (restart Phase-1), ④ dispose (final shutdown),
 * ⑤ reset (test). Request/shutdown/route consumers operate on ONE runtime instance
 * rather than reaching a module-global directly.
 */
export interface TelemetryRuntime {
  /** ① Rebuild the in-memory 7d window from SQLite + freeze `effectiveSketchGamma` + stash the pre-startup legacy-JSON snapshot. Runs BEFORE the server listens. */
  initialize(): Promise<void>
  /** ② Absorb the frozen legacy-JSON snapshot into telemetry.db. Runs AFTER the server listens (non-blocking; structurally disjoint from post-startup tel_raw writes). */
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
  initialize(): Promise<void> {
    return initRequestTelemetry()
  }
  runJsonBackfill(now?: number): void {
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
