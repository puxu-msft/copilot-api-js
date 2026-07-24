/**
 * Telemetry domain injected dependencies — the telemetry package's external ports.
 *
 * The telemetry domain reads core-owned config + filesystem paths but must not
 * import core modules directly (`~/lib/state`, `~/lib/config/paths`) or it could
 * never become a leaf package. Instead the composition root (a core-side assembly
 * module) adapts core primitives into these role interfaces and installs them here;
 * the telemetry package's registry reads the installed ports via {@link getTelemetryDeps}.
 *
 * This mirrors the token domain's `dependencies.ts` seam: a single live indirection
 * set once by the owner. The installed `config` is a LIVE view (each getter reads
 * current core state) so a config hot-reload is honoured on the next read — telemetry
 * OWNS no config (SoT stays in core-config; the registry is a read-only consumer).
 */

/** Where the telemetry domain persists its SQLite db + reads the legacy JSON (assembly adapts `PATHS`). */
export interface TelemetryPaths {
  /** `PATHS.TELEMETRY_DB` default — the SQLite telemetry store. */
  readonly telemetryDbPath: string
  /** `PATHS.REQUEST_TELEMETRY` — the legacy JSON snapshot (read only for migration/backfill). */
  readonly requestTelemetryJsonPath: string
}

/**
 * Core-owned telemetry config the registry reads but does NOT own — injected as a
 * LIVE view (each getter reads current core state) so a config hot-reload is honoured
 * on the next read.
 *
 * NB the per-field lifecycle differs (see the telemetry peel plan §3.1): `enabled` /
 * `persistInterval` / `rollupInterval` retune timers via {@link TelemetryConfigSubscription};
 * `cardinalityCap` / `cumulative` / the retention fields are next-record/next-tick live
 * reads; `sketchGamma` is a DB-open FROZEN candidate (the runtime freezes it into
 * `effectiveSketchGamma`, then never re-reads the live value — a hot γ change would wedge
 * the DDSketch write). `dbPath` is an init-only selection.
 */
export interface TelemetryConfigView {
  readonly enabled: boolean
  readonly dbPath: string
  readonly persistInterval: number
  readonly rollupInterval: number
  readonly cardinalityCap: number
  readonly sketchGamma: number
  readonly cumulative: boolean
  readonly rawResolutionMinutes: number
  readonly rawRetentionDays: number
  readonly hourlyRetentionDays: number
  readonly dailyRetentionDays: number
}

/**
 * Config-change subscription port (adapts core `onTelemetryConfigChange`). The registry
 * subscribes to retune the persist/rollup timers when the timer-relevant config fields
 * (`enabled` / `persistInterval` / `rollupInterval`) change.
 */
export interface TelemetryConfigSubscription {
  onChange(listener: () => void): () => void
}

/** The full set of ports the telemetry runtime needs from its host. */
export interface TelemetryRuntimeDependencies {
  readonly paths: TelemetryPaths
  readonly config: TelemetryConfigView
  readonly configSubscription: TelemetryConfigSubscription
}

let installed: TelemetryRuntimeDependencies | null = null

/**
 * Install the telemetry domain's ports. Called by the composition root (production)
 * and the test floor. Idempotent overwrite — the ports are stateless adapters over
 * live core state, so last-writer-wins is safe (unlike the runtime singleton, which
 * guards against two owners).
 */
export function installTelemetryDeps(deps: TelemetryRuntimeDependencies): void {
  installed = deps
}

/** Read the installed ports, failing fast if the host never installed them. */
export function getTelemetryDeps(): TelemetryRuntimeDependencies {
  if (!installed) {
    throw new Error(
      "Telemetry dependencies not installed — the composition root (or test floor) must call installTelemetryDeps() before any telemetry operation",
    )
  }
  return installed
}
