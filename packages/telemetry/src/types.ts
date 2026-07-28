/**
 * Pure-TYPE barrel for `@hsupu/ghc-proxy-telemetry` — the snapshot shapes the History web UI
 * (`ui-v4`) consumes.
 *
 * The frontend re-exports backend types rather than redeclaring them (the project's
 * single-source-of-truth-types rule), but it must not pull the backend RUNTIME into its bundle —
 * this module's graph is types only (no `consola`, no `bun:sqlite`, no DDSketch), so a
 * `@hsupu/ghc-proxy-telemetry/types` import can never drag a server dependency into the browser
 * build even if a bundler fails to erase a type-only import.
 */

export type {
  //
  DimensionBreakdownSnapshot,
  DimensionKeySnapshot,
  DimensionSeriesPoint,
  HistogramSummary,
  RequestTelemetryBucket,
  RequestTelemetryModelBucket,
  RequestTelemetryModelSeriesSnapshot,
  RequestTelemetryModelSnapshot,
  RequestTelemetrySnapshot,
  RequestTelemetryUsageTotals,
  TelemetryUsage,
} from "./request-telemetry"
