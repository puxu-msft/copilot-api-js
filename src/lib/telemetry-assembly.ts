/**
 * Composition root for the telemetry domain — the core-side assembly module that adapts core
 * primitives into the telemetry domain's injected ports and owns the process-singleton
 * {@link TelemetryRuntime}.
 *
 * The telemetry domain must not import core (`~/lib/state`, `~/lib/config/paths`) or it could
 * never become a leaf package. This module lives in CORE and bridges the two: it builds a
 * {@link TelemetryRuntimeDependencies} from `PATHS` (the SQLite + legacy-JSON paths), a LIVE view
 * over the core-owned `telemetry.*` config (`state.telemetry*`, whose SoT is core-config — the
 * telemetry domain is a read-only consumer, unlike token there is NO SoT reversal), and
 * `onTelemetryConfigChange` (the timer-retune subscription).
 *
 * Deliberately named `telemetry-assembly` rather than `telemetry-runtime` (which the token domain
 * uses for its core-side counterpart): the domain's own runtime module already occupies that name
 * here and moves to `packages/telemetry/src/runtime.ts` at the physical peel, so keeping the two
 * apart by name — package RUNTIME vs core ASSEMBLY — keeps both readable.
 *
 * `installDefaultTelemetryRuntime()` is idempotent (returns the already-installed runtime) so the
 * server bootstrap and the test fixture can both call it freely.
 */

import {
  //
  installTelemetryDeps,
  type TelemetryConfigSubscription,
  type TelemetryConfigView,
  type TelemetryPaths,
  type TelemetryRuntimeDependencies,
} from "@hsupu/ghc-proxy-telemetry"
import {
  //
  createTelemetryRuntime,
  installTelemetryRuntime,
  peekTelemetryRuntime,
  type TelemetryRuntime,
} from "@hsupu/ghc-proxy-telemetry"

import { PATHS } from "~/lib/config/paths"
import {
  //
  onTelemetryConfigChange,
  state,
} from "~/lib/state"

/** The telemetry persistence paths port, read from core `PATHS`. */
const telemetryPaths: TelemetryPaths = {
  get telemetryDbPath(): string {
    return PATHS.TELEMETRY_DB
  },
  get requestTelemetryJsonPath(): string {
    return PATHS.REQUEST_TELEMETRY
  },
}

/**
 * LIVE core-state view of the `telemetry.*` config the domain reads but does not own — every field
 * is a getter, so a config hot-reload is honoured at the domain's next read (per-field lifecycle
 * contract on {@link TelemetryConfigView}; `sketchGammaCandidate` is the one field the domain reads
 * once per db-open and then freezes).
 */
const telemetryConfig: TelemetryConfigView = {
  get enabled(): boolean {
    return state.telemetryEnabled
  },
  get dbPath(): string {
    return state.telemetryDbPath
  },
  get persistInterval(): number {
    return state.telemetryPersistInterval
  },
  get rollupInterval(): number {
    return state.telemetryRollupInterval
  },
  get cardinalityCap(): number {
    return state.telemetryCardinalityCap
  },
  get sketchGammaCandidate(): number {
    return state.telemetrySketchGamma
  },
  get cumulative(): boolean {
    return state.telemetryCumulative
  },
  get rawResolutionMinutes(): number {
    return state.telemetryRawResolutionMinutes
  },
  get rawRetentionDays(): number {
    return state.telemetryRawRetentionDays
  },
  get hourlyRetentionDays(): number {
    return state.telemetryHourlyRetentionDays
  },
  get dailyRetentionDays(): number {
    return state.telemetryDailyRetentionDays
  },
}

/** The timer-retune subscription port, adapting core `onTelemetryConfigChange`. */
const telemetryConfigSubscription: TelemetryConfigSubscription = {
  onChange: (listener) => onTelemetryConfigChange(listener),
}

/** The full dependency set the telemetry runtime is constructed from. */
export function buildTelemetryRuntimeDependencies(): TelemetryRuntimeDependencies {
  return { paths: telemetryPaths, config: telemetryConfig, configSubscription: telemetryConfigSubscription }
}

/**
 * Install ONLY the telemetry domain's ambient ports (paths/config/subscription) without a runtime
 * singleton. Used by the test floor so the registry resolves its config even in tests that never
 * assemble a runtime (they drive the registry directly through the domain's `testing` entry).
 * Production installs these via {@link installDefaultTelemetryRuntime}.
 */
export function installDefaultTelemetryDeps(): void {
  installTelemetryDeps(buildTelemetryRuntimeDependencies())
}

/**
 * Construct and install the default telemetry runtime (idempotent). Returns the installed
 * singleton — call it from the process entry point (server bootstrap, test fixture) BEFORE any
 * telemetry lifecycle op, so the tolerant `peekTelemetryRuntime()?.op()` consumers (the record
 * legs, the read routes, shutdown) find an assembled runtime.
 */
export function installDefaultTelemetryRuntime(): TelemetryRuntime {
  const existing = peekTelemetryRuntime()
  if (existing) return existing

  const runtime = createTelemetryRuntime(buildTelemetryRuntimeDependencies())
  installTelemetryRuntime(runtime)
  return runtime
}
