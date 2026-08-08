/**
 * L1 completeness guard for the unified test-isolation fixture.
 *
 * The fixture's `RESETTERS` table (tests/helpers/isolated-fixture.ts) is the
 * single place to register a module-global singleton's per-test reset. "Add a
 * line when you add a singleton" is a human contract that drifts — so this guard
 * enumerates EVERY `*ForTest(s|ing)` export under `src/` and asserts each is
 * either registered in `RESETTERS` or listed in the documented `EXEMPT` map.
 *
 * Adding a new `fooForTests` export to `src/` without registering or exempting
 * it fails this test loudly (mirrors the config-hot-reload completeness guard).
 *
 * NOTE on enumeration: the regex uses `\w` (digits included) on purpose —
 * `setHttp2SessionFactoryForTests` has a digit in its name and an
 * `[A-Za-z_]`-only pattern silently drops it.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { RESETTER_NAMES } from "../helpers/isolated-fixture"

const SRC_DIR = path.resolve(import.meta.dir, "../../src")
const REPO_ROOT = path.resolve(import.meta.dir, "../..")

// Module-global singletons live in `src/` AND (since the monorepo split) in
// `packages/*/src/`. Reset exports must be enumerated across every package
// source root, else moving a singleton into a package makes its registered
// RESETTER look "stale". See spec §8.2.
function packageSrcRoots(): Array<string> {
  const packagesDir = path.join(REPO_ROOT, "packages")
  if (!fs.existsSync(packagesDir)) return []
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(packagesDir, e.name, "src")))
    .map((e) => path.join(packagesDir, e.name, "src"))
}
const SRC_ROOTS = [SRC_DIR, ...packageSrcRoots()]

/**
 * Exports enumerated by the guard but intentionally NOT in `RESETTERS`, each
 * with the reason it does not belong in the fixture's afterEach reset loop.
 */
const EXEMPT: Record<string, string> = {
  // Async drain-reset; the fixture uses the sync `clearAnthropicFeatureNegotiationForTests` instead.
  resetAnthropicFeatureNegotiationForTesting: "async drain variant — fixture uses sync clear",
  // Per-request mutator, not a module-global: it aborts ONE context's lifecycle with no cause tag,
  // to impersonate a producer that skipped the `cancellationAbortError` contract. Nothing to reset —
  // the context dies with the request.
  abortLifecycleUntaggedForTests: "per-request mutator — no module-global state",
  // State mechanism — handled by snapshot/restore in the fixture.
  setStateForTests: "state mutator — covered by snapshot/restore",
  snapshotStateForTests: "state snapshot mechanism",
  restoreStateForTests: "state restore mechanism",
  // Registry teardown, NOT a per-test reset. Participants are registered once by the bun test
  // preload (see src/lib/token-runtime.ts); clearing them between tests would leave every
  // credential key unclaimed and `setStateForTests` would throw. It exists so a test can PROVE the
  // unclaimed-key error fires, and every caller restores the registry in a `finally`.
  clearSnapshotParticipantsForTests: "registry teardown for negative tests — must NOT run per-test",
  // Token store snapshot/restore — the credential store's snapshot mechanism,
  // composed into snapshotStateForTests/restoreStateForTests (so the per-test
  // state snapshot atomically covers credentials). No independent reset.
  snapshotTokenStoreForTests: "token-store snapshot mechanism — composed into snapshotStateForTests",
  restoreTokenStoreForTests: "token-store restore mechanism — composed into restoreStateForTests",
  // Handled inside resetTestRuntime (runtime trio), not the RESETTERS table.
  resetBusForTests: "handled by resetTestRuntime",
  resetRequestContextManagerForTests: "handled by resetTestRuntime",
  // Upstream fetch seam — handled by the network guard + restoreFetch.
  setUpstreamFetchForTests: "upstream seam — network guard + restoreFetch",
  // Path/config injector setters: per-test opt-in, not a default reset. Their
  // effect is undone either by a paired reset already in the table or by the
  // floor (sandboxed PATHS default).
  setLearnedLimitsPathForTests: "path setter — per-test opt-in",
  _setRequestTelemetryFilePathForTests: "path setter — per-test opt-in",
  setBundledConfigForTests: "config injector — reset via resetBundledConfigCacheForTests",
  setAbortableDelayScaleForTests: "delay-scale setter — reset via resetAbortableDelayScaleForTests (registered)",
  // telemetry.db assertion/inspection hooks (read-only getters) — no module-global state to reset.
  _getTelemetryDbForTests: "read-only assertion hook — no state to reset",
  _getOutboxSizeForTests: "read-only assertion hook — no state to reset",
  _getEffectiveSketchGammaForTests: "read-only assertion hook — no state to reset",
  _getCumulativeCapKeysForTests: "read-only assertion hook — no state to reset",
  _projectDimBucketsForTests: "read-only projection hook — no state to reset",
  _isRollupTimerArmedForTests: "read-only assertion hook — no state to reset",
  _isTelemetryShutdownSealedForTests: "read-only assertion hook — no state to reset",
  _runRollupTickForTests: "action hook (drives one rollup tick) — no state to reset",
  drainScheduledCalibrationPersistenceForTests: "action hook — consumes calibration's existing timer; resetAllLimitsForTesting owns reset",
  drainScheduledNegotiationPersistenceForTests: "action hook — consumes negotiation's existing timer; clearAnthropicFeatureNegotiationForTests owns reset",
  resetReaperDiagnosticsForTests: "diagnostic snapshot reset — exercised by its owning tests",
  // Read-only assertion hook (is the V3 maintenance timer currently armed?) —
  // no module-global state of its own to reset; the timer itself is
  // start/stopped by production code paths (initHistory/shutdownHistory), and
  // tests that arm it directly (db-health.it.test.ts) tear it down themselves
  // via stopV3Maintenance() in their own afterEach.
  isV3MaintenanceRunningForTests: "read-only assertion hook — no state to reset",
  // telemetry injectors: per-test opt-in; their effect is undone by _resetRequestTelemetryForTests
  // (registered), which closes the injected db handle + restores OUTBOX_SOFT_CAP.
  _setTelemetryDbForTests: "db injector — reset via _resetRequestTelemetryForTests",
  _setOutboxSoftCapForTests: "soft-cap injector — reset via _resetRequestTelemetryForTests",
  // compat.ts's own warn-once tracking is drained by the ALREADY-registered
  // _resetConfigValidationWarnTrackingForTests (validation.ts), which calls this
  // internally — registering both would double-reset the same Set.
  _resetDeprecatedKeyWarnTrackingForTests: "covered by _resetConfigValidationWarnTrackingForTests, which calls it internally",
  // V3 store transient-retry seams (DI-5): a read-only config getter (no state)
  // and a fault injector setter whose module-global is cleared centrally by the
  // ALREADY-registered resetV3WriterForTests.
  getV3PersistRetryConfigForTests: "read-only assertion hook — no state to reset",
  setV3CommitFailureInjectorForTests: "commit-failure injector setter — cleared by resetV3WriterForTests (registered)",
  // This reads the existing deliverySessionTestHooks observer and does not mutate module state;
  // setDeliverySessionTestHooksForTests owns that state and is the registered resetter.
  recordDeliveryResponseOutcomeForTests: "read-only assertion observer — state reset by setDeliverySessionTestHooksForTests",
  // Injection setter remains available to tests that install explicit fakes. The fixture registers the
  // async owning reset instead, because merely clearing the pointer would leak a live Worker.
  setHistoryPersistenceRuntimeForTests: "runtime injector — reset via resetHistoryPersistenceRuntimeForTests (registered)",
}

function enumerateForTestExports(dir: string): Set<string> {
  const names = new Set<string>()
  const re = /export\s+(?:async\s+)?function\s+(\w*ForTest(?:s|ing))\b/g
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(".ts")) {
        const src = fs.readFileSync(full, "utf8")
        for (const m of src.matchAll(re)) names.add(m[1])
      }
    }
  }
  walk(dir)
  return names
}

describe("RESETTERS table is complete (no module-global reset drifts unregistered)", () => {
  const enumerated = new Set<string>()
  for (const root of SRC_ROOTS) {
    for (const name of enumerateForTestExports(root)) enumerated.add(name)
  }

  test("the enumeration actually found exports (guard is not vacuously passing)", () => {
    // Self-check: an empty enumeration would make the assertions below trivially
    // pass (pass-null blindness). Anchor on a known export.
    expect(enumerated.size).toBeGreaterThan(10)
    expect(enumerated.has("resetRawModelsForTests")).toBe(true)
  })

  test("every src `*ForTest(s|ing)` export is registered or explicitly exempted", () => {
    const unaccounted = [...enumerated].filter((n) => !RESETTER_NAMES.has(n) && !(n in EXEMPT))
    expect(unaccounted).toEqual([])
  })

  test("no stale entries: every RESETTER name and every EXEMPT key still exists in src", () => {
    // Names in the table that are not `*ForTest(s|ing)`-named (production resets,
    // not test-only injectors) — the enumeration regex never finds these, so skip
    // the existence check for them.
    const NOT_FOR_TESTS_NAMED = new Set(["resetHistoryPersistErrorStats", "resetUpstreamHook"])
    for (const name of RESETTER_NAMES) {
      if (NOT_FOR_TESTS_NAMED.has(name)) continue
      expect(enumerated.has(name)).toBe(true)
    }
    for (const name of Object.keys(EXEMPT)) {
      expect(enumerated.has(name)).toBe(true)
    }
  })
})
