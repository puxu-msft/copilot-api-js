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
import { setStateForTests } from "~/lib/state"

let initialized = false
let detachSinks: Array<() => void> = []

/**
 * One-time runtime setup for tests:
 * - SQLite history opened IN-MEMORY (`:memory:`): faster, leak-free across test
 *   files (each open is a fresh empty db — see connection.ts), and no temp file
 *   to clean up. Tests that exercise real on-disk db features (WAL / startup
 *   VACUUM / reaper persistence across reopen) inject their own `mkdtemp` path
 *   and do NOT route through bootstrap (see tests/history/sqlite/*.it). RFC §11 R7.
 * - observability bus + minimal sinks (History persists; Telemetry counts)
 * - request context manager wired to the bus's `request.*` publisher
 *
 * WsSink and ConsoleSink are NOT attached: tests that need them install
 * them explicitly (avoids stdout pollution + WS broadcast attempts to
 * non-existent clients).
 */
export function bootstrapTestRuntime() {
  if (initialized) return

  setStateForTests({ historyDbPath: ":memory:" })
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
  // Re-assert `:memory:` here too: a preceding restoreStateForTests may have
  // rolled historyDbPath back to "" (real path), so pin it before reopening.
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 100)
  clearHistory()
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
