/**
 * `@hsupu/ghc-proxy-telemetry` — the request-telemetry domain: the settled/accepted measure
 * registry, its tiered SQLite store, and the runtime that owns their lifecycle.
 *
 * The package depends only on `@hsupu/ghc-proxy-foundation` plus declared externals; everything it
 * needs from core (the `telemetry.*` config, the persistence paths, the config-change
 * subscription) arrives through the injected ports in `./dependencies`, assembled by the core-side
 * composition root (`src/lib/telemetry-assembly.ts`). The boundary is machine-enforced by
 * `tests/architecture/package-boundaries.unit.test.ts` + the matching ESLint block.
 *
 * This barrel is the domain's PRODUCTION surface: the runtime (the only way to drive the
 * lifecycle / record / read operations), the dimension name registry, the snapshot types, and the
 * SQLite tier read primitives the `/api/stats` route serves the 30d/90d/lifetime windows from.
 * The registry's free functions are deliberately NOT re-exported — driving them directly is the
 * escape hatch the peel removed (see `./testing` for the test-only entry, and
 * `tests/architecture/telemetry-domain-surface.unit.test.ts` for the guard).
 */

// ── Composition root: the process-singleton runtime + its injected ports ──
export {
  //
  getTelemetryDeps,
  installTelemetryDeps,
  type TelemetryConfigSubscription,
  type TelemetryConfigView,
  type TelemetryPaths,
  type TelemetryRuntimeDependencies,
} from "./dependencies"
// ── Dimension NAME registry (the entry/ctx-free half; core owns the extractors) ──
export {
  //
  CAPPED_DIMENSION_NAMES,
  TELEMETRY_DIMENSION_NAMES,
  TELEMETRY_DIMENSION_SPECS,
  type TelemetryDimensionCardinality,
  type TelemetryDimensionName,
  type TelemetryDimensionSpec,
  type ThinkingBlockCounts,
} from "./dimension-names"
// ── Registry metadata constants (measure/histogram names, the breakdown default) ──
export {
  //
  DEFAULT_BREAKDOWN_LIMIT,
  TELEMETRY_HISTOGRAMS,
  TELEMETRY_MEASURE_NAMES,
} from "./request-telemetry"
export {
  //
  createTelemetryRuntime,
  getTelemetryRuntime,
  installTelemetryRuntime,
  peekTelemetryRuntime,
  resetTelemetryRuntimeForTests,
  type TelemetryRuntime,
} from "./runtime"
// ── SQLite store: the open handle type + the tier read primitives `/api/stats` serves from ──
export { type TelemetryDatabase } from "./telemetry/db"
export {
  //
  type DistributionSummary,
  readCumulativeBreakdown,
  readCumulativeSketchQuantiles,
  readJsonBackfillBoundaryTs,
  readTierBreakdown,
  readTierSketchQuantiles,
  type TierBreakdownResult,
  type TierKeyCounters,
} from "./telemetry/read"
// ── Snapshot / measure-input types (also re-exported type-only from ./types for the frontend) ──
export type * from "./types"
