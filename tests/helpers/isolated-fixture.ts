/**
 * Unified per-test isolation fixture — the default isolation surface for
 * `.it`/`.http` tests.
 *
 * Goal (RFC docs/rfc/test-env-isolation.md §8): make isolation the DEFAULT
 * construction, not an opt-in each test must remember. A single
 * `useIsolatedRuntime()` at the top of a describe gives every test:
 *   - a bootstrapped runtime (history in-memory, observability bus + sinks,
 *     request-context manager) — via `bootstrapTestRuntime`/`resetTestRuntime`
 *   - pristine global `~/lib/state` (per-test snapshot/restore)
 *   - every module-global singleton reset in afterEach (the `RESETTERS` table) —
 *     this is the real increment over the bunfig preload floor, which only
 *     redirects fs paths and cannot catch in-process cross-test map leaks
 *   - a network guard: any UNMOCKED upstream fetch throws loudly instead of
 *     hitting the real network (install a mock to override, or opt out)
 *
 * fs isolation is NOT this fixture's job — it is owned by the bunfig preload
 * floor (`sandbox-paths.ts`, redirecting XDG_DATA_HOME + CODEX_HOME). This is a
 * deliberate layering: the floor is the fs ground, the fixture is the in-process
 * state ground. A test that needs a non-default fs path injects it via the
 * relevant `set*PathForTests` seam.
 *
 * The `RESETTERS` table is the single place to register a new module-global
 * singleton's reset; the L1 guard `tests/infra/resetters-complete.unit.test.ts`
 * fails if any `*ForTest(s|ing)` export is neither in this table nor the
 * documented exemptions — so the table cannot silently drift.
 */

import { resetTelemetryRuntimeForTests } from "@hsupu/ghc-proxy-telemetry"
import { _resetRequestTelemetryForTests } from "@hsupu/ghc-proxy-telemetry/testing"
import {
  //
  afterEach,
  beforeAll,
  beforeEach,
} from "bun:test"

import { clearAnthropicFeatureNegotiationForTests } from "~/lib/anthropic/feature-negotiation"
import { resetProtectStreamingStatsForTests } from "~/lib/anthropic/protect-streaming-stats"
import { resetToolInputRepairStatsForTests } from "~/lib/anthropic/tool-input-repair-stats"
import { resetBundledConfigCacheForTests } from "~/lib/config/config"
import { _resetConfigValidationWarnTrackingForTests } from "~/lib/config/validation"
import { resetModelOperationTerminalRegistryForTests } from "~/lib/context/lightweight-model-operation"
import { resetDiagnosticLoggerForTests } from "~/lib/diagnostics"
import { resetStructuredFileSinkForTests } from "~/lib/diagnostics/file"
import { resetBootstrapSpoolForTests } from "~/lib/diagnostics/file/bootstrap-spool"
import { resetHistoryPersistErrorStats } from "~/lib/history/persist-guard"
import { resetRawCaptureManagerForTests } from "~/lib/history/raw/manager"
import { setNativeHistorySearchForTests } from "~/lib/history/search-native"
import {
  //
  drainV3Writer,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import { resetModelOperationTerminalBusForTests } from "~/lib/history/v3/terminal-bus"
import { clearRecentModelOperationTerminalsForTests } from "~/lib/history/v3/terminal-bus"
import { resetAllLimitsForTesting } from "~/lib/models/calibration/engine"
import { resetModelsEtagForTests } from "~/lib/models/client"
import { resetAbortProvenanceGapsForTests } from "~/lib/observability/abort-provenance-gaps"
import { resetReaperDiagnosticsForTests } from "~/lib/observability/reaper-diagnostics"
import { resetRetryGiveUpsForTests } from "~/lib/observability/retry-giveups"
import { resetRetryStrategyFiresForTests } from "~/lib/observability/retry-strategy-fires"
import { resetResponseSessionStoreForTests } from "~/lib/openai/response-session-store"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"
import { resetProcessIdentityForTests } from "~/lib/process-identity"
import {
  //
  resetRawModelsForTests,
  restoreStateForTests,
  type StateSnapshot,
  snapshotStateForTests,
} from "~/lib/state"
import {
  //
  installDefaultTelemetryDeps,
  installDefaultTelemetryRuntime,
} from "~/lib/telemetry-assembly"
import { resetTokenRuntimeForTests } from "~/lib/token"
import {
  //
  setConnectTimeoutForTests,
  setHttp2SessionFactoryForTests,
} from "~/lib/transport/http2-client"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"
import { resetSensitiveOutputForTests } from "~/lib/tui/sensitive-output"
import { resetTerminalCoordinatorForTests } from "~/lib/tui/terminal-coordinator"
import {
  //
  resetAbortableDelayScaleForTests,
  setAbortableDelayScaleForTests,
} from "~/lib/util/abortable-delay"

import { restoreFetch } from "./mock-fetch"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "./test-bootstrap"

/**
 * Module-global singletons reset in afterEach. Each entry carries its export
 * `name` so the L1 completeness guard can enumerate `*ForTest(s|ing)` source
 * exports and assert each is registered here (or explicitly exempted).
 *
 * NOT listed here (handled elsewhere, exempted in the L1 guard):
 *   - state (snapshot/restore), history/bus/context/rate-limiter (resetTestRuntime),
 *     fetch/upstream (restoreFetch + network guard).
 */
export const RESETTERS: ReadonlyArray<{ name: string; reset: () => void | Promise<void> }> = [
  { name: "clearAnthropicFeatureNegotiationForTests", reset: clearAnthropicFeatureNegotiationForTests },
  { name: "resetModelOperationTerminalRegistryForTests", reset: resetModelOperationTerminalRegistryForTests },
  { name: "resetModelOperationTerminalBusForTests", reset: resetModelOperationTerminalBusForTests },
  { name: "clearRecentModelOperationTerminalsForTests", reset: clearRecentModelOperationTerminalsForTests },
  { name: "resetV3WriterForTests", reset: resetV3WriterForTests },
  { name: "resetRawCaptureManagerForTests", reset: resetRawCaptureManagerForTests },
  { name: "setNativeHistorySearchForTests", reset: () => setNativeHistorySearchForTests(undefined) },
  { name: "resetResponseSessionStoreForTests", reset: resetResponseSessionStoreForTests },
  { name: "resetProtectStreamingStatsForTests", reset: resetProtectStreamingStatsForTests },
  { name: "resetToolInputRepairStatsForTests", reset: resetToolInputRepairStatsForTests },
  { name: "resetAllLimitsForTesting", reset: resetAllLimitsForTesting },
  // Telemetry teardown is ORDER-DEPENDENT and these two entries must stay in THIS order:
  // `resetTelemetryRuntimeForTests` disposes the runtime, and a final-shutdown dispose SEALS the
  // registry (`telemetryShutdownSealed = true`, so a late config callback cannot re-arm timers
  // against a closing db). Only the registry hard-reset clears that seal — so running the registry
  // reset FIRST would leave every following test sealed, silently disabling config-driven timer
  // re-arming. (This used to claim order-independence; it never was.)
  { name: "resetTelemetryRuntimeForTests", reset: resetTelemetryRuntimeForTests },
  { name: "_resetRequestTelemetryForTests", reset: _resetRequestTelemetryForTests },
  { name: "resetModelsEtagForTests", reset: resetModelsEtagForTests },
  { name: "resetRawModelsForTests", reset: resetRawModelsForTests },
  { name: "resetProcessIdentityForTests", reset: resetProcessIdentityForTests },
  { name: "resetAbortableDelayScaleForTests", reset: resetAbortableDelayScaleForTests },
  { name: "resetReaperDiagnosticsForTests", reset: resetReaperDiagnosticsForTests },
  { name: "resetRetryStrategyFiresForTests", reset: resetRetryStrategyFiresForTests },
  { name: "resetAbortProvenanceGapsForTests", reset: resetAbortProvenanceGapsForTests },
  { name: "resetRetryGiveUpsForTests", reset: resetRetryGiveUpsForTests },
  { name: "_resetConfigValidationWarnTrackingForTests", reset: _resetConfigValidationWarnTrackingForTests },
  { name: "resetBundledConfigCacheForTests", reset: resetBundledConfigCacheForTests },
  { name: "resetUpstreamWsManagerForTests", reset: () => void resetUpstreamWsManagerForTests() },
  // Injected factory/writer seams: reset to their default (null/undefined) so a
  // mock injected by one test never leaks into the next (RFC §11 R2).
  { name: "setUpstreamWsConnectionFactoryForTests", reset: () => setUpstreamWsConnectionFactoryForTests(null) },
  { name: "setHttp2SessionFactoryForTests", reset: () => setHttp2SessionFactoryForTests(undefined) },
  { name: "setConnectTimeoutForTests", reset: () => setConnectTimeoutForTests(undefined) },
  // Not `*ForTests`-named (a production reset) but a module-global counter that
  // leaks across tests, so reset it here too.
  { name: "resetHistoryPersistErrorStats", reset: resetHistoryPersistErrorStats },
  // TUI terminal-coordinator module-level singleton (whole-branch review I3):
  // a test that constructs a non-`silent` TerminalUi and forgets `destroy()`
  // would otherwise leak its registration into the next test file.
  { name: "resetTerminalCoordinatorForTests", reset: resetTerminalCoordinatorForTests },
  { name: "resetSensitiveOutputForTests", reset: resetSensitiveOutputForTests },
  // Token runtime process-singleton: a CLI-flow test that installs a runtime
  // (installDefaultTokenRuntime) must not leak it (its refresh timer / owned
  // managers) into the next test. dispose() stops the timer + drains in-flight
  // refresh, then the singleton is cleared. (The token DEPS — fetch/paths/config
  // ports — are stateless adapters installed once at the floor and never reset.)
  { name: "resetTokenRuntimeForTests", reset: resetTokenRuntimeForTests },
  { name: "resetStructuredFileSinkForTests", reset: resetStructuredFileSinkForTests },
  { name: "resetBootstrapSpoolForTests", reset: resetBootstrapSpoolForTests },
  { name: "resetDiagnosticLoggerForTests", reset: resetDiagnosticLoggerForTests },
  // Upstream-hook DI seam (module-global `hookState`, read at driver-suite level
  // via `getUpstreamHook()`): a test file that loads/injects a hook and forgets
  // its own afterEach would otherwise leak the mounted hook into any later test —
  // including files that never import the hooks module at all (whole-branch
  // review I-1). Not `*ForTests`-named (a production reset), like
  // `resetHistoryPersistErrorStats` above.
  { name: "resetUpstreamHook", reset: resetUpstreamHook },
  // The DI-seam setter itself: reset to its default (undefined) so an injected
  // test hook never leaks, mirroring the other injected-seam entries above.
  // Functionally redundant with `resetUpstreamHook` (both clear the same
  // `hookState`), kept as its own entry for parity with the other `set*ForTests`
  // seams in this table and so the L1 guard sees it registered, not exempted.
  { name: "setUpstreamHookForTests", reset: () => setUpstreamHookForTests(undefined) },
]

/** Names registered in RESETTERS — consumed by the L1 completeness guard. */
export const RESETTER_NAMES: ReadonlySet<string> = new Set(RESETTERS.map((r) => r.name))

export interface IsolatedRuntimeOptions {
  /**
   * Upstream network policy. `"guard"` (default) installs a throwing
   * `upstreamFetch` so any unmocked upstream call fails loudly; a test that
   * installs its own mock (`setFetchMock`/`applyFetchMock`) overrides it.
   * `"passthrough"` installs nothing (for tests that intentionally reach a real
   * local service or forward via `realFetch`).
   */
  network?: "guard" | "passthrough"
}

function installUpstreamGuard(): void {
  // Reject (not throw): callers treat upstreamFetch as `() => Promise<Response>`
  // and `await` it; a synchronous throw would escape before the promise exists
  // (and break `.rejects` assertions). A rejected promise surfaces the same way
  // through any `await`.
  setUpstreamFetchForTests((url) =>
    Promise.reject(
      new Error(
        `[isolated-fixture] unmocked upstream fetch to ${String(url)} — install a mock via setFetchMock/applyFetchMock, or pass network:"passthrough" to useIsolatedRuntime()`,
      ),
    ),
  )
}

/**
 * Register the standard isolated runtime lifecycle for a describe block. Call
 * once at the top, before any test. Replaces the ad-hoc combination of
 * `autoTestRuntime()` + `autoRestoreState()` + `autoRestoreFetch()` + per-test
 * negotiation resets.
 *
 * The state snapshot is captured per-test in a `beforeEach` registered here, so
 * it runs before any file-specific `beforeEach` added afterwards (keeping the
 * snapshot pristine). Place file-specific setup in a later `beforeEach`.
 *
 * IMPORTANT (RFC §11 R5): do NOT also call `autoRestoreState()` in the same
 * file — two restorers with different snapshot timings (call-time vs per-test)
 * can fight over `mutableState` and the registration-order winner pollutes the
 * baseline. This fixture subsumes state restore; use it alone.
 */
export function useIsolatedRuntime(opts: IsolatedRuntimeOptions = {}): void {
  const network = opts.network ?? "guard"
  let snapshot: StateSnapshot

  beforeAll(async () => {
    await bootstrapTestRuntime()
    // Full runtime re-wire ONCE per describe, in case the PREVIOUS test file did NOT use
    // this fixture (e.g. a history `.it` test with its own real-DB lifecycle that closed
    // the DB and/or left a stale bus + request-context manager). bootstrapTestRuntime's
    // `initialized` guard skips re-wiring on every call after the first, and the per-test
    // afterEach `resetTestRuntime` only covers tests 2..N within THIS file — so test 1
    // would otherwise inherit the predecessor's stale wiring (closed DB → "database not
    // initialized", or a dead bus → request events never reach the history sink → no
    // persisted entry). resetTestRuntime reopens `:memory:`, swaps in a fresh bus + sinks,
    // and re-wires the manager; it is the same call afterEach uses, so this is idempotent.
    await resetTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    // Assemble the telemetry domain exactly as production start.ts does, so the tolerant
    // `peekTelemetryRuntime()` legs (accepted/settled recording) and the fail-fast read routes
    // (`/api/status`, `/api/stats`, `/metrics`) see the same wiring here as on the server. Runs in
    // beforeEach — not resetTestRuntime — because RESETTERS clears the singleton in afterEach.
    //
    // Re-installing the PORTS (not just the runtime) is what makes this immune to a preceding file
    // that installed fakes: the deps holder is a last-writer-wins module singleton with no reset, so
    // without this a fake `TelemetryConfigView` from another test file would silently persist into
    // every later test in the same worker.
    installDefaultTelemetryDeps()
    installDefaultTelemetryRuntime()
    // Retry-backoff waits (dispatch-scheduler `abortableDelay`) resolve instantly under
    // the fixture — the declared waitMs/queueWaitMs accounting is untouched. Cuts seconds
    // off any retry-triggering test (e.g. the v4 http golden files). Reset to 1 in afterEach.
    setAbortableDelayScaleForTests(0)
    if (network === "guard") installUpstreamGuard()
  })

  afterEach(async () => {
    // Drain any fire-and-forget async V3 terminal write (a request that settled
    // during the test kicks one via `subscribeModelOperationTerminals`, see
    // state.ts) BEFORE resetTestRuntime swaps/closes the DB — otherwise the
    // in-flight write lands on a closed handle ("Cannot use a closed database")
    // or leaks into the next test. Mirrors the production shutdown drain
    // (`shutdownHistory`'s `drainV3Writer` call).
    await drainV3Writer()
    restoreStateForTests(snapshot)
    await resetTestRuntime()
    // Serial await: a resetter may be async (future-proofing) — fire-and-forget
    // would let an enqueued write land in the next test (the exact class of leak
    // this fixture exists to kill).
    for (const { reset } of RESETTERS) await reset()
    restoreFetch()
  })
}
