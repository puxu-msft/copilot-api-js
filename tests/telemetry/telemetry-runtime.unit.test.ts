/**
 * T1 seam: the telemetry runtime composition root — process-singleton lifecycle +
 * facade delegation to the module-local request-telemetry registry.
 *
 * This proves the SEAM (install/get/peek/reset semantics + that the facade actually
 * delegates through to the module singleton), NOT the registry internals (those are
 * covered by tests/pipeline/request-telemetry.unit.test.ts). The config injection
 * itself is wired + exercised in T2.
 */

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
  _resetRequestTelemetryForTests,
  getRequestTelemetrySnapshot,
} from "~/lib/request-telemetry"
import {
  //
  type TelemetryConfigView,
  type TelemetryRuntimeDependencies,
  getTelemetryDeps,
  installTelemetryDeps,
} from "~/lib/telemetry-dependencies"
import {
  //
  createTelemetryRuntime,
  getTelemetryRuntime,
  installTelemetryRuntime,
  peekTelemetryRuntime,
  resetTelemetryRuntimeForTests,
} from "~/lib/telemetry-runtime"

const fakeConfig: TelemetryConfigView = {
  enabled: false,
  dbPath: "",
  persistInterval: 60,
  rollupInterval: 3600,
  cardinalityCap: 200,
  sketchGamma: 0.0075,
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

beforeEach(async () => {
  // Clean singleton + module state so each test starts from "no runtime installed".
  await resetTelemetryRuntimeForTests()
  _resetRequestTelemetryForTests()
})

afterEach(async () => {
  await resetTelemetryRuntimeForTests()
  _resetRequestTelemetryForTests()
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
