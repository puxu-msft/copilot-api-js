import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
import { setHistoryStoreWipeForTests } from "~/lib/history/store"
import { resetModelOperationTerminalBusForTests } from "~/lib/history/v3/terminal-bus"
import { resetHistoryAdmissionLifecycleForTests } from "~/lib/history/worker/http-admission"
import { setHistoryAdmissionControllerForTests, setHistoryPersistenceRuntimeFactoryForTests } from "~/lib/history/worker/registry"
import {
  //
  initBus,
  resetBusForTests,
} from "~/lib/observability"
import { attachTelemetrySink } from "~/lib/observability/sinks/telemetry"
import { _resetShutdownState } from "~/lib/shutdown"
import { setStateForTests } from "~/lib/state"

import { clearHistoryStoreForTests } from "./history-v3-fixtures"
import { createInProcessHistoryPersistenceRuntime } from "../history/worker/fixtures/in-process-runtime"

let initialized = false
let detachSinks: Array<() => void> = []
let historyDbPath: string | undefined

/**
 * The on-disk semantic artifact this test process uses, created once and reused.
 *
 * Exported because History can no longer be opened at `:memory:` — the Worker owns the write connection and the main thread opens an independent readonly one, and an in-memory SQLite database belongs to exactly one connection. Test files that used to pin `historyDbPath: ":memory:"` call this instead. Returning the SAME path the bootstrap already brought up is deliberate: `initHistory` then takes its idempotent branch rather than tearing the Worker down and starting another one against a second artifact.
 *
 * A fresh path per call would defeat that idempotency and would strand a directory per test. Cleanup is registered on `exit` rather than done per test, because the artifact must outlive every reset within the process.
 */
export function historyTestDbPath(): string {
  if (historyDbPath) return historyDbPath
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-history-test-"))
  historyDbPath = path.join(dir, "history-v3.db")
  process.on("exit", () => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return historyDbPath
}

/**
 * One-time runtime setup for tests:
 * - SQLite history opened on an ON-DISK path under a per-process temp dir. It used to be `:memory:`, which the Worker cutover (Batch 2b) made structurally impossible: an in-memory SQLite database belongs to ONE connection, and History now has two — the Worker owns the write handle, the main thread opens an independent readonly handle (`openDatabaseReadonly`, which rejects `:memory:` outright). Keeping `:memory:` would mean tests exercise a one-handle shape that production no longer has, so the very invariant this batch introduces would be untestable. The dir is per test PROCESS, and `bun test --parallel` gives each file its own worker, so files do not share an artifact. Tests that exercise real on-disk db features (WAL / startup VACUUM / reaper persistence across reopen) still inject their own `mkdtemp` path and do NOT route through bootstrap (see tests/history/sqlite/*.it). RFC §11 R7.
 * - History persistence runtime bound to the IN-PROCESS Worker backend, via a registry FACTORY rather than a single injected instance: a runtime is single-use, so every later re-creation (a `historyDbPath` switch, a test that shut History down, the per-test injector reset) must also resolve to the in-process backend instead of silently spawning a real Worker thread mid-run. The in-process backend runs the same message loop over the same backend as the real Worker, only without the thread boundary (see fixtures/in-process-runtime.ts).
 * - observability bus + minimal sinks (Telemetry counts). History persistence is NOT driven by a sink here — mirrors production, where `initHistory`'s internal V3 terminal-bus subscription (`subscribeModelOperationTerminals`, see state.ts) is the sole persistence path; `attachHistorySink` was only ever a tests-only V2 shim and has been removed (History V2 removal Phase 1; see docs/plan/2026-07-15-history-v2-removal/v3-projection-gap-audit.md "D 步").
 * - request context manager wired to the bus's `request.*` publisher
 *
 * WsSink and ConsoleSink are NOT attached: tests that need them install them explicitly (avoids stdout pollution + WS broadcast attempts to non-existent clients).
 */
export async function bootstrapTestRuntime(): Promise<void> {
  if (initialized) return

  setHistoryPersistenceRuntimeFactoryForTests(() => createInProcessHistoryPersistenceRuntime())
  // `clearHistory()` can no longer wipe the persisted store by itself — that would be a main-thread writer against the artifact the Worker owns. Hand it a wipe backed by the fixtures' own write connection, so every existing `clearHistory()` caller keeps its clean slate.
  setHistoryStoreWipeForTests(clearHistoryStoreForTests)
  setStateForTests({ historyDbPath: historyTestDbPath() })
  await initHistory(true, 100)

  const bus = initBus()
  const historyPub = bus.scope("history")
  setHistoryPublisher(historyPub)
  detachSinks = [attachTelemetrySink(bus)]

  initRequestContextManager({ publisher: bus.scope("request") })

  initialized = true
}

export async function resetTestRuntime(): Promise<void> {
  _resetShutdownState()
  resetHistoryAdmissionLifecycleForTests()
  setHistoryAdmissionControllerForTests(undefined)
  resetModelOperationTerminalBusForTests()
  // Re-initialize history before clearing. A preceding test that called shutdownHistory() — or the fixture's per-test runtime reset, which releases the registry singleton so an injected mock cannot leak — would otherwise leave History with no writer, so the next file's getHistory()/queryEntries() reads a stale handle or the terminal sink drops on the floor. `initHistory()` re-installs whatever is missing and is a no-op when the runtime is still up; clearHistory() then empties both the in-flight map and the table for a clean slate.
  // Re-assert the bootstrap path here too: a preceding restoreStateForTests may have rolled historyDbPath back to "" (the sandbox's real path), so pin it before reopening.
  setStateForTests({ historyDbPath: historyTestDbPath() })
  await initHistory(true, 100)
  clearHistory()
  resetAdaptiveRateLimiter()

  // Tear down old sinks BEFORE swapping the bus, otherwise their
  // subscriptions hang off a stale bus reference.
  for (const detach of detachSinks) detach()
  const bus = resetBusForTests()
  const historyPub = bus.scope("history")
  setHistoryPublisher(historyPub)
  detachSinks = [attachTelemetrySink(bus)]

  resetRequestContextManagerForTests({ publisher: bus.scope("request") })
}
