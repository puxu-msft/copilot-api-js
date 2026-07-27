/**
 * The telemetry domain's TEST-ONLY entry point (becomes `@hsupu/ghc-proxy-telemetry/testing` at the
 * physical peel).
 *
 * Production code reaches telemetry through exactly ONE surface — the assembled
 * {@link TelemetryRuntime} (`get`/`peekTelemetryRuntime()`); the registry's free functions are
 * domain-internal and no longer a public escape hatch (machine-checked by
 * `tests/architecture/telemetry-domain-surface.unit.test.ts`). Tests, however, legitimately need to
 * drive the registry directly and to poke its internals, so the domain exposes that capability HERE
 * — explicitly, in a separately-named entry — rather than by leaving the production surface wide.
 *
 * Two kinds of exports:
 *  - **registry drivers** — the lifecycle / record / read functions a test can call without
 *    assembling a runtime (the registry's state is module-local, so these operate on the same
 *    singleton the runtime facade delegates to).
 *  - **test hooks** (`_*ForTests`) — the injection + assertion seams (db handle, JSON path, outbox
 *    soft cap, rollup tick, frozen γ, …). These are re-exported, not redeclared, so the L1
 *    `resetters-complete` guard still enumerates them at their single declaration site.
 */

import {
  //
  getTelemetryDeps,
  type TelemetryRuntimeDependencies,
} from "./dependencies"
import {
  //
  createTelemetryRuntime,
  type TelemetryRuntime,
} from "./runtime"

export {
  //
  _getCumulativeCapKeysForTests,
  _getEffectiveSketchGammaForTests,
  _getOutboxSizeForTests,
  _getTelemetryDbForTests,
  _isRollupTimerArmedForTests,
  _isTelemetryShutdownSealedForTests,
  _projectDimBucketsForTests,
  _resetRequestTelemetryForTests,
  _runRollupTickForTests,
  _setOutboxSoftCapForTests,
  _setRequestTelemetryFilePathForTests,
  _setTelemetryDbForTests,
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

/**
 * Build a telemetry runtime for a test, defaulting every port to the ambient deps installed by the
 * test floor (`tests/helpers/install-telemetry-deps.ts`) so a test only has to name the ports it
 * actually wants to fake. Does NOT install the runtime singleton — pass it to
 * `installTelemetryRuntime` when the test needs the tolerant `peek` consumers (sink, routes,
 * shutdown) to see it.
 */
export function createTestTelemetryRuntime(overrides: Partial<TelemetryRuntimeDependencies> = {}): TelemetryRuntime {
  return createTelemetryRuntime({ ...getTelemetryDeps(), ...overrides })
}
