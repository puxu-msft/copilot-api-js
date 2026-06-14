import {
  //
  afterEach,
  beforeAll,
  beforeEach,
} from "bun:test"

import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import {
  //
  initRequestContextManager,
  resetRequestContextManagerForTests,
} from "~/lib/context/manager"
import {
  //
  clearHistory,
  initHistory,
  setHistoryPublisher,
} from "~/lib/history"
import {
  //
  initBus,
  resetBusForTests,
} from "~/lib/observability"
import { attachHistorySink } from "~/lib/observability/sinks/history"
import { attachTelemetrySink } from "~/lib/observability/sinks/telemetry"
import { _resetShutdownState } from "~/lib/shutdown"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import { tuiLogger } from "~/lib/tui"

let initialized = false
let detachSinks: Array<() => void> = []

/**
 * One-time runtime setup for tests:
 * - SQLite history (in-memory)
 * - observability bus + minimal sinks (History persists; Telemetry counts)
 * - request context manager wired to the bus's `request.*` publisher
 *
 * WsSink and ConsoleSink are NOT attached: tests that need them install
 * them explicitly (avoids stdout pollution + WS broadcast attempts to
 * non-existent clients).
 */
export function bootstrapTestRuntime() {
  if (initialized) return

  initHistory(true, 100)

  const bus = initBus()
  const historyPub = bus.scope("history")
  setHistoryPublisher(historyPub)
  detachSinks = [attachHistorySink(bus, { publisher: historyPub }), attachTelemetrySink(bus)]

  initRequestContextManager({ publisher: bus.scope("request") })

  initialized = true
}

export function resetTestRuntime() {
  _resetShutdownState()
  // Re-initialize history (idempotent reopen of the SQLite DB) before clearing.
  // A preceding test that called shutdownHistory()/closeDatabase() would otherwise
  // leave the shared DB closed, so the next file's getHistory()/queryEntries()
  // throws "database not initialized". initHistory() reopens it; clearHistory()
  // then empties both the in-flight map and the table for a clean slate.
  initHistory(true, 100)
  clearHistory()
  tuiLogger.clear()
  resetAdaptiveRateLimiter()

  // Tear down old sinks BEFORE swapping the bus, otherwise their
  // subscriptions hang off a stale bus reference.
  for (const detach of detachSinks) detach()
  const bus = resetBusForTests()
  const historyPub = bus.scope("history")
  setHistoryPublisher(historyPub)
  detachSinks = [attachHistorySink(bus, { publisher: historyPub }), attachTelemetrySink(bus)]

  resetRequestContextManagerForTests({ publisher: bus.scope("request") })
}

/**
 * Register the standard runtime lifecycle for an HTTP-style test describe:
 *   - `bootstrapTestRuntime()` once before all tests (idempotent)
 *   - snapshot global state before each test
 *   - restore state + `resetTestRuntime()` after each test
 *
 * Collapses the boilerplate repeated across the `.http.test.ts` files:
 *   let snapshot: StateSnapshot
 *   beforeAll(() => bootstrapTestRuntime())
 *   beforeEach(() => { snapshot = snapshotStateForTests() })
 *   afterEach(() => { restoreStateForTests(snapshot); resetTestRuntime() })
 *
 * The snapshot is captured in a `beforeEach` registered by this call, so it
 * runs before any file-specific `beforeEach` (setStateForTests / setModels)
 * registered afterwards — keeping the snapshot pristine. Place file-specific
 * per-test setup in a separate `beforeEach` after calling this.
 *
 * Mirrors `autoRestoreFetch()` / `autoRestoreState()`. State restore and
 * runtime reset are orthogonal (state object vs history/context/rate-limiter
 * singletons), so this composes cleanly with the fetch helper.
 */
export function autoTestRuntime(): void {
  let snapshot: StateSnapshot
  beforeAll(() => {
    bootstrapTestRuntime()
  })
  beforeEach(() => {
    snapshot = snapshotStateForTests()
  })
  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })
}
