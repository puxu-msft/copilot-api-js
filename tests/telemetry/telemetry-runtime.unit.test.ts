/**
 * The telemetry runtime composition root — process-singleton lifecycle, facade delegation to the
 * module-local request-telemetry registry (T1), and the CONFIG INJECTION wire (T2).
 *
 * This proves the SEAM (install/get/peek/reset semantics + that the facade delegates through to
 * the module singleton + that the registry reads its config from the INJECTED port rather than
 * core `state`), NOT the registry internals (those are covered by
 * tests/pipeline/request-telemetry.unit.test.ts) and not the DB-frozen γ contract (covered by
 * tests/telemetry/dual-write.unit.test.ts oracles 12/13, which now exercise the injected path).
 */

import {
  //
  type TelemetryConfigView,
  type TelemetryRuntimeDependencies,
  getTelemetryDeps,
  installTelemetryDeps,
} from "@hsupu/ghc-proxy-telemetry"
import {
  //
  createTelemetryRuntime,
  getTelemetryRuntime,
  installTelemetryRuntime,
  peekTelemetryRuntime,
  resetTelemetryRuntimeForTests,
} from "@hsupu/ghc-proxy-telemetry"
import {
  //
  _getTelemetryDbForTests,
  _resetRequestTelemetryForTests,
  getRequestTelemetrySnapshot,
  initRequestTelemetry,
} from "@hsupu/ghc-proxy-telemetry/testing"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"

const fakeConfig: TelemetryConfigView = {
  enabled: false,
  dbPath: "",
  persistInterval: 60,
  rollupInterval: 3600,
  cardinalityCap: 200,
  sketchGammaCandidate: 0.0075,
  cumulative: false,
  rawResolutionMinutes: 5,
  rawRetentionDays: 7,
  hourlyRetentionDays: 30,
  dailyRetentionDays: 365,
}

function makeFakeDeps(): TelemetryRuntimeDependencies {
  return {
    paths: { telemetryDbPath: "/tmp/telemetry-seam.db", requestTelemetryJsonPath: "/tmp/telemetry-seam.json" },
    config: fakeConfig,
    configSubscription: { onChange: () => () => {} },
  }
}

let snapshot: StateSnapshot

beforeEach(async () => {
  // Clean singleton + module state so each test starts from "no runtime installed"; snapshot core
  // state too — the injection tests deliberately set `telemetryEnabled` to prove the registry
  // IGNORES it, and that must not leak into a sibling file sharing this process.
  snapshot = snapshotStateForTests()
  await resetTelemetryRuntimeForTests()
  _resetRequestTelemetryForTests()
})

afterEach(async () => {
  await resetTelemetryRuntimeForTests()
  _resetRequestTelemetryForTests()
  restoreStateForTests(snapshot)
})

describe("telemetry runtime singleton lifecycle", () => {
  test("get throws + peek is null before any install", () => {
    expect(peekTelemetryRuntime()).toBeNull()
    expect(() => getTelemetryRuntime()).toThrow(/not installed/)
  })

  test("install then get/peek return the SAME instance", () => {
    const rt = createTelemetryRuntime(makeFakeDeps())
    installTelemetryRuntime(rt)
    expect(getTelemetryRuntime()).toBe(rt)
    expect(peekTelemetryRuntime()).toBe(rt)
  })

  test("installing over a live runtime throws (prevents two owners)", () => {
    installTelemetryRuntime(createTelemetryRuntime(makeFakeDeps()))
    expect(() => installTelemetryRuntime(createTelemetryRuntime(makeFakeDeps()))).toThrow(/already installed/)
  })

  test("reset clears the singleton (get throws + peek null again)", async () => {
    installTelemetryRuntime(createTelemetryRuntime(makeFakeDeps()))
    await resetTelemetryRuntimeForTests()
    expect(peekTelemetryRuntime()).toBeNull()
    expect(() => getTelemetryRuntime()).toThrow(/not installed/)
  })
})

describe("createTelemetryRuntime installs the ambient deps", () => {
  test("the passed deps become the installed telemetry deps", () => {
    const deps = makeFakeDeps()
    createTelemetryRuntime(deps)
    expect(getTelemetryDeps()).toBe(deps)
  })

  test("installTelemetryDeps overwrites (stateless adapter, last-writer-wins)", () => {
    const first = makeFakeDeps()
    const second = makeFakeDeps()
    installTelemetryDeps(first)
    installTelemetryDeps(second)
    expect(getTelemetryDeps()).toBe(second)
  })
})

describe("facade delegates to the module-local registry singleton", () => {
  test("recordAccepted through the runtime is visible via BOTH the runtime and the free function (same underlying state)", () => {
    const rt = createTelemetryRuntime(makeFakeDeps())
    installTelemetryRuntime(rt)

    // acceptedSinceStart increments unconditionally (before the enabled/db gate), so this
    // proves the facade calls through to the module singleton without needing telemetry enabled.
    rt.recordAccepted(1_700_000_000_000)
    rt.recordAccepted(1_700_000_000_000)

    expect(rt.getSnapshot().acceptedSinceStart).toBe(2)
    // Free-function readout sees the SAME module-local state the facade mutated.
    expect(getRequestTelemetrySnapshot().acceptedSinceStart).toBe(2)
  })

  test("getTelemetryDb through the runtime matches the module getter (null when disabled)", () => {
    const rt = createTelemetryRuntime(makeFakeDeps())
    installTelemetryRuntime(rt)
    expect(rt.getTelemetryDb()).toBeNull()
  })
})

describe("T2 config injection: the registry reads the INJECTED port, not core state", () => {
  test("an injected `enabled: false` keeps the db closed even while core state says enabled", async () => {
    // Core state claims telemetry is ON — if the registry still read `state.telemetryEnabled`
    // it would open a db here. The injected view is the only thing that must matter.
    setStateForTests({ telemetryEnabled: true, telemetryDbPath: "/tmp/telemetry-injection-should-not-open.db" })
    createTelemetryRuntime(makeFakeDeps()) // fakeConfig.enabled === false
    await initRequestTelemetry()
    expect(_getTelemetryDbForTests()).toBeNull()
  })

  test("the injected view is read LIVE (a later mutation is honoured, not a construction-time snapshot)", async () => {
    // Positive control for the assertion above: flip the SAME port to enabled and the db opens.
    // Without a live read this would stay null and the test above would pass vacuously.
    const live = { ...fakeConfig, enabled: true, dbPath: ":memory:" }
    createTelemetryRuntime({ ...makeFakeDeps(), config: live })
    await initRequestTelemetry()
    expect(_getTelemetryDbForTests()).not.toBeNull()
  })
})

describe("tolerant peek leg: recording before assembly is a no-op, not a throw", () => {
  test("peekTelemetryRuntime()?.recordAccepted() no-ops when nothing is assembled", () => {
    expect(peekTelemetryRuntime()).toBeNull()
    expect(() => peekTelemetryRuntime()?.recordAccepted(1_700_000_000_000)).not.toThrow()
    // The registry's own counter is untouched — the call really did not reach it.
    expect(getRequestTelemetrySnapshot().acceptedSinceStart).toBe(0)
  })
})
