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

/**
 * Exports enumerated by the guard but intentionally NOT in `RESETTERS`, each
 * with the reason it does not belong in the fixture's afterEach reset loop.
 */
const EXEMPT: Record<string, string> = {
  // Async drain-reset; the fixture uses the sync `clearAnthropicFeatureNegotiationForTests` instead.
  resetAnthropicFeatureNegotiationForTesting: "async drain variant — fixture uses sync clear",
  // State mechanism — handled by snapshot/restore in the fixture.
  setStateForTests: "state mutator — covered by snapshot/restore",
  snapshotStateForTests: "state snapshot mechanism",
  restoreStateForTests: "state restore mechanism",
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
  // telemetry.db assertion/inspection hooks (read-only getters) — no module-global state to reset.
  _getTelemetryDbForTests: "read-only assertion hook — no state to reset",
  _getOutboxSizeForTests: "read-only assertion hook — no state to reset",
  _getEffectiveSketchGammaForTests: "read-only assertion hook — no state to reset",
  _getCumulativeCapKeysForTests: "read-only assertion hook — no state to reset",
  _projectDimBucketsForTests: "read-only projection hook — no state to reset",
  _isRollupTimerArmedForTests: "read-only assertion hook — no state to reset",
  _isTelemetryShutdownSealedForTests: "read-only assertion hook — no state to reset",
  _runRollupTickForTests: "action hook (drives one rollup tick) — no state to reset",
  resetReaperDiagnosticsForTests: "diagnostic snapshot reset — exercised by its owning tests",
  // telemetry injectors: per-test opt-in; their effect is undone by _resetRequestTelemetryForTests
  // (registered), which closes the injected db handle + restores OUTBOX_SOFT_CAP.
  _setTelemetryDbForTests: "db injector — reset via _resetRequestTelemetryForTests",
  _setOutboxSoftCapForTests: "soft-cap injector — reset via _resetRequestTelemetryForTests",
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
  const enumerated = enumerateForTestExports(SRC_DIR)

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
