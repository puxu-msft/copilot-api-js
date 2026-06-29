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

import {
  //
  afterEach,
  beforeAll,
  beforeEach,
} from "bun:test"

import { clearAnthropicFeatureNegotiationForTests } from "~/lib/anthropic/feature-negotiation"
import { resetProtectStreamingStatsForTests } from "~/lib/anthropic/protect-streaming-stats"
import { resetToolInputRepairStatsForTests } from "~/lib/anthropic/tool-input-repair-stats"
import { resetAllLimitsForTesting } from "~/lib/auto-truncate/engine"
import { resetBundledConfigCacheForTests } from "~/lib/config/config"
import { _resetConfigValidationWarnTrackingForTests } from "~/lib/config/validation"
import {
  //
  __setTerminalWriterForTests,
  drainPendingFinalizations,
} from "~/lib/history/entries"
import { resetHistoryPersistErrorStats } from "~/lib/history/persist-guard"
import { resetSearchIndexBackfillForTests } from "~/lib/history/sqlite/search-index-backfill"
import { resetModelsEtagForTests } from "~/lib/models/client"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import { resetProcessIdentityForTests } from "~/lib/process-identity"
import { _resetRequestTelemetryForTests } from "~/lib/request-telemetry"
import {
  //
  resetRawModelsForTests,
  restoreStateForTests,
  type StateSnapshot,
  snapshotStateForTests,
} from "~/lib/state"
import { setHttp2SessionFactoryForTests } from "~/lib/transport/http2-client"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

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
  { name: "resetProtectStreamingStatsForTests", reset: resetProtectStreamingStatsForTests },
  { name: "resetToolInputRepairStatsForTests", reset: resetToolInputRepairStatsForTests },
  { name: "resetAllLimitsForTesting", reset: resetAllLimitsForTesting },
  { name: "_resetRequestTelemetryForTests", reset: _resetRequestTelemetryForTests },
  { name: "resetModelsEtagForTests", reset: resetModelsEtagForTests },
  { name: "resetRawModelsForTests", reset: resetRawModelsForTests },
  { name: "resetProcessIdentityForTests", reset: resetProcessIdentityForTests },
  { name: "_resetConfigValidationWarnTrackingForTests", reset: _resetConfigValidationWarnTrackingForTests },
  { name: "resetBundledConfigCacheForTests", reset: resetBundledConfigCacheForTests },
  { name: "resetUpstreamWsManagerForTests", reset: () => void resetUpstreamWsManagerForTests() },
  // Injected factory/writer seams: reset to their default (null/undefined) so a
  // mock injected by one test never leaks into the next (RFC §11 R2).
  { name: "setUpstreamWsConnectionFactoryForTests", reset: () => setUpstreamWsConnectionFactoryForTests(null) },
  { name: "setHttp2SessionFactoryForTests", reset: () => setHttp2SessionFactoryForTests(undefined) },
  { name: "__setTerminalWriterForTests", reset: () => __setTerminalWriterForTests(undefined) },
  // Not `*ForTests`-named (a production reset) but a module-global counter that
  // leaks across tests, so reset it here too.
  { name: "resetHistoryPersistErrorStats", reset: resetHistoryPersistErrorStats },
  // search_index backfill module-global stop/running flags.
  { name: "resetSearchIndexBackfillForTests", reset: resetSearchIndexBackfillForTests },
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

  beforeAll(() => {
    bootstrapTestRuntime()
    // Full runtime re-wire ONCE per describe, in case the PREVIOUS test file did NOT use
    // this fixture (e.g. a history `.it` test with its own real-DB lifecycle that closed
    // the DB and/or left a stale bus + request-context manager). bootstrapTestRuntime's
    // `initialized` guard skips re-wiring on every call after the first, and the per-test
    // afterEach `resetTestRuntime` only covers tests 2..N within THIS file — so test 1
    // would otherwise inherit the predecessor's stale wiring (closed DB → "database not
    // initialized", or a dead bus → request events never reach the history sink → no
    // persisted entry). resetTestRuntime reopens `:memory:`, swaps in a fresh bus + sinks,
    // and re-wires the manager; it is the same call afterEach uses, so this is idempotent.
    resetTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    if (network === "guard") installUpstreamGuard()
  })

  afterEach(async () => {
    // Drain any fire-and-forget async finalize (a request that settled during the
    // test kicks one via the history sink) BEFORE resetTestRuntime swaps/closes the
    // DB — otherwise the in-flight finalize lands on a closed handle ("Cannot use a
    // closed database") or leaks into the next test. Mirrors the production shutdown
    // drain (RFC history-finalize-async-offload I4).
    await drainPendingFinalizations()
    restoreStateForTests(snapshot)
    resetTestRuntime()
    // Serial await: a resetter may be async (future-proofing) — fire-and-forget
    // would let an enqueued write land in the next test (the exact class of leak
    // this fixture exists to kill).
    for (const { reset } of RESETTERS) await reset()
    restoreFetch()
  })
}
