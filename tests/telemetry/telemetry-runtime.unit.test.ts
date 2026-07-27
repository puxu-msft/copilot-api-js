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
  type TelemetryRuntime,
  getTelemetryRuntime,
  installTelemetryRuntime,
  peekTelemetryRuntime,
  resetTelemetryRuntimeForTests,
} from "@hsupu/ghc-proxy-telemetry"
import { openTelemetryDb } from "@hsupu/ghc-proxy-telemetry/telemetry/db"
import {
  //
  _getTelemetryDbForTests,
  _isTelemetryShutdownSealedForTests,
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
import { writeFileSync } from "node:fs"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import { installDefaultTelemetryDeps } from "~/lib/telemetry-assembly"

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
  // This file installs FAKE ports (makeFakeDeps) to prove the registry reads the injected view.
  // The deps holder is last-writer-wins with no reset of its own, so the fakes must be handed back
  // explicitly — otherwise every later file in this worker reads `enabled: false` / `:memory:`.
  installDefaultTelemetryDeps()
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

describe("teardown really hands the domain back (the leak this file used to cause)", () => {
  test("after the RESETTERS sequence the ports are the LIVE core view again, not this file's fakes", async () => {
    // Reproduces the exact failure found in merged-state review: this file installs fake ports, and
    // before the fix they survived into every later file in the same worker (backfill tests then
    // read `enabled: false` and wrote to `:memory:`).
    createTelemetryRuntime(makeFakeDeps())
    expect(getTelemetryDeps().config.enabled).toBe(false) // the fake

    await resetTelemetryRuntimeForTests()
    _resetRequestTelemetryForTests()
    installDefaultTelemetryDeps()

    // Live view again: a core-state mutation is visible through the port.
    setStateForTests({ telemetryEnabled: true })
    expect(getTelemetryDeps().config.enabled).toBe(true)
    setStateForTests({ telemetryEnabled: false })
    expect(getTelemetryDeps().config.enabled).toBe(false)
  })

  test("the runtime reset must run BEFORE the registry reset, or every later test stays SEALED", async () => {
    const runtime = createTelemetryRuntime(makeFakeDeps())
    installTelemetryRuntime(runtime)

    // The fixture's order: dispose the runtime (which seals the registry), THEN hard-reset the
    // registry (which is the only thing that clears the seal). A sealed registry silently refuses to
    // re-arm its timers on a config change, so a leaked seal disables hot-reload for the rest of the
    // worker without failing anything loudly.
    await resetTelemetryRuntimeForTests()
    expect(_isTelemetryShutdownSealedForTests()).toBe(true) // dispose sealed it — this is the trap
    _resetRequestTelemetryForTests()
    expect(_isTelemetryShutdownSealedForTests()).toBe(false)

    installDefaultTelemetryDeps()
  })
})

describe("the runtime OWNS the startup phase order (a runtime oracle, not a source-order guard)", () => {
  const BACKFILL_NOW = Date.now()
  let tmpDir: string
  let dbPath: string
  let jsonPath: string

  /**
   * A legacy-JSON snapshot with real, in-retention content, so "did the backfill run" is OBSERVABLE.
   * The bucket must be an ALIGNED 5-minute timestamp inside the retention window — a `0` bucket is
   * pruned on absorption and would make both branches look identical again.
   */
  function writeLegacySnapshot(): void {
    const bucket = Math.floor((BACKFILL_NOW - 2 * 86_400_000) / 300_000) * 300_000
    const envelope = {
      version: 3,
      buckets: { [String(bucket)]: 6 },
      dimensions: { model: { buckets: { [String(bucket)]: { opus: { requestCount: 4, inputTokens: 200 } } } } },
    }
    writeFileSync(jsonPath, JSON.stringify(envelope), "utf8")
  }

  /** A runtime whose telemetry.db is a real file (so a second connection can observe absorption). */
  function makeDbBackedRuntime(): TelemetryRuntime {
    return createTelemetryRuntime({
      paths: { telemetryDbPath: dbPath, requestTelemetryJsonPath: jsonPath },
      config: { ...fakeConfig, enabled: true, cumulative: true, dbPath },
      configSubscription: { onChange: () => () => {} },
    })
  }

  /** Rows absorbed into tel_raw, read through an INDEPENDENT connection — the oracle. */
  function absorbedRows(): number {
    const db = openTelemetryDb(dbPath)
    try {
      return (db.prepare("SELECT COUNT(*) AS v FROM tel_raw").get() as { v: number }).v
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "telemetry-phase-order-"))
    dbPath = join(tmpDir, "telemetry.db")
    jsonPath = join(tmpDir, "request-telemetry.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("markServerListening fail-fasts when initialize never ran", () => {
    const rt = createTelemetryRuntime(makeFakeDeps())
    // Serving requests against an unbuilt 7d window / unfrozen γ is a wiring bug, not a degraded mode.
    expect(() => rt.markServerListening()).toThrow(/initialize\(\) never completed/)
  })

  test("a backfill that arrives BEFORE the listening mark is deferred, then runs AT the mark", async () => {
    // This is the invariant a source-order guard could only approximate: even with the calls in the
    // WRONG order, the absorption still happens after the server is listening, never during startup.
    writeLegacySnapshot()
    const rt = makeDbBackedRuntime()
    await rt.initialize()

    rt.runJsonBackfill(BACKFILL_NOW) // too early
    // NOTE the oracle: the legacy snapshot has real rows, so "absorbed" is distinguishable from
    // "ran but had nothing to do". An earlier version of this test used an empty db and passed
    // whether or not the deferral existed — both branches were no-ops.
    expect(absorbedRows()).toBe(0)

    rt.markServerListening()
    expect(absorbedRows()).toBeGreaterThan(0)
  })

  test("in the production order the backfill absorbs at its own call site", async () => {
    writeLegacySnapshot()
    const rt = makeDbBackedRuntime()
    await rt.initialize()
    rt.markServerListening()
    expect(absorbedRows()).toBe(0) // nothing has asked for it yet

    rt.runJsonBackfill(BACKFILL_NOW)
    expect(absorbedRows()).toBeGreaterThan(0)
  })

  test("re-marking does not absorb twice", async () => {
    // What this pins is the OBSERVABLE outcome. The single-shot property comes from the registry
    // (it consumes its pending snapshot and trips a version guard), not from the runtime clearing
    // its deferred slot — removing that clear changes nothing here, so this test is not evidence
    // for it, and the code says so.
    writeLegacySnapshot()
    const rt = makeDbBackedRuntime()
    await rt.initialize()
    rt.runJsonBackfill(BACKFILL_NOW)
    rt.markServerListening()
    const afterFirst = absorbedRows()
    expect(afterFirst).toBeGreaterThan(0)

    rt.markServerListening()
    expect(absorbedRows()).toBe(afterFirst) // no double absorption
  })
})
