import type { ScopedPublisher } from "~/lib/observability"

import { PATHS } from "~/lib/config/paths"
import {
  //
  onHistoryRawCaptureChange,
  state,
} from "~/lib/state"

import { clearInFlight } from "./in-flight"
import {
  //
  configureRawCapture,
  shutdownRawCapture,
} from "./raw/manager"
import {
  //
  createHistorySearchSupervisor,
  type HistorySearchSupervisor,
} from "./search/supervisor"
import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "./sqlite/connection"
import { applyForwardMigrations } from "./sqlite/migrations/run"
import {
  //
  startV3Maintenance,
  stopV3Maintenance,
} from "./v3/maintenance"
import {
  //
  drainV3Writer,
  drainV3SummaryBackfill,
  enqueueModelOperation,
  ensureV3Schema,
  recoverV3Journal,
  startV3SummaryBackfill,
  stopV3SummaryBackfill,
} from "./v3/store"
import {
  //
  clearRecentModelOperationTerminalsForTests,
  drainModelOperationTerminalSubscribers,
  subscribeModelOperationTerminals,
} from "./v3/terminal-bus"

let enabled = false
let unsubscribeV3Terminal: (() => void) | undefined
let unsubscribeRawCapture: (() => void) | undefined
let _publisher: ScopedPublisher<"history"> | undefined
/**
 * Out-of-process history-search sidecar supervisor (history-search-out-of-
 * process plan Phase 3). `undefined` whenever search is not running.
 *
 * Gated on the ABSENCE of `state.historyDbPath` (the injected test seam), not
 * merely on-disk-vs-`:memory:` — see the gate in `initHistory` below for the
 * full rationale (an earlier, narrower gate leaked a real spawned OS process
 * from two on-disk-path test suites whose `afterEach` only closes the DB
 * directly, confirmed empirically via `ps aux` during a full backend test
 * run). Every `.unit`/`.it`/`.http` test — `:memory:` via `useIsolatedRuntime`
 * AND the two real-file test suites that inject a temp `historyDbPath` — never
 * spawns a sidecar process; only genuine production use (`start.ts`, no
 * injected test seam) does.
 */
let historySearchSupervisor: HistorySearchSupervisor | undefined

export const historyState = {
  get enabled(): boolean {
    return enabled
  },
  /**
   * Scoped publisher for `history.*` events. Set once at start.ts via
   * `setHistoryPublisher`. Read by entries.ts / sessions.ts to publish
   * `history.entry_added/updated/stats_changed/cleared/session_deleted`
   * after every SQLite write. Undefined in test runs that don't set it —
   * write paths then silently skip the publish step (the WS broadcast is
   * a sink concern, not a correctness concern).
   */
  get publisher(): ScopedPublisher<"history"> | undefined {
    return _publisher
  },
}

/**
 * The out-of-process history-search sidecar's supervisor, when running (undefined
 * when search is disabled — see `historySearchSupervisor`'s doc comment). Read by
 * `status/route.ts` (`history_search` status) and (future Phase 4) the REST search
 * handler for its UDS client.
 */
export function getHistorySearchSupervisor(): HistorySearchSupervisor | undefined {
  return historySearchSupervisor
}

/**
 * Install the bus publisher used by the history subsystem to emit
 * `history.*` events. Called once at `start.ts` after `initBus()`.
 * Tests that need WS broadcast behavior call this themselves; tests
 * that only need persistence can leave it unset.
 */
export function setHistoryPublisher(publisher: ScopedPublisher<"history"> | undefined): void {
  _publisher = publisher
}

export function isHistoryEnabled(): boolean {
  return enabled
}

/** Stop and discard the current supervisor, if any. Never-throw: `stop()` itself
 *  is a graceful SIGTERM/SIGKILL sequence that does not throw; this wrapper exists
 *  so every caller doesn't need to null-check. */
async function stopHistorySearchSupervisor(): Promise<void> {
  const supervisor = historySearchSupervisor
  historySearchSupervisor = undefined
  if (supervisor) await supervisor.stop()
}

export async function initHistory(enable: boolean, _legacyMaxEntries?: number): Promise<void> {
  clearInFlight()
  clearRecentModelOperationTerminalsForTests()
  enabled = enable
  if (!enable) {
    unsubscribeV3Terminal?.()
    unsubscribeV3Terminal = undefined
    await stopHistorySearchSupervisor()
    unsubscribeRawCapture?.()
    unsubscribeRawCapture = undefined
    stopV3Maintenance()
    shutdownRawCapture()
    closeDatabase()
    return
  }
  // `historyDbPath` is retained only as an injected test seam during the V3
  // cutover. Production config cannot set it; the default is a physically
  // separate V3 artifact, so opening History never mutates legacy history.db.
  const dbPath = state.historyDbPath || PATHS.HISTORY_V3_DB
  openDatabase(dbPath)
  ensureV3Schema(getDatabase())
  // Umzug forward-migration pipe (History V2 removal Phase 4d): `MIGRATIONS`
  // (migrations/index.ts) is intentionally empty today — this call's value is
  // wiring the pipe end-to-end (storage construction, ledger read/write,
  // logger adapter) against the REAL V3 db, so the first real 001+ migration
  // has a proven-working runner to land into, rather than adding one now.
  // RETHROWS on failure (see migrations/run.ts) — a half-applied schema
  // migration must refuse to start, not silently continue.
  await applyForwardMigrations(getDatabase())
  recoverV3Journal(getDatabase())
  unsubscribeV3Terminal?.()
  unsubscribeV3Terminal = subscribeModelOperationTerminals(enqueueModelOperation)
  // Out-of-process history-search sidecar (Phase 3): spawn a REAL child OS
  // process ONLY for genuine production use (no injected `historyDbPath` test
  // seam active) — NOT merely "on-disk vs :memory:". A test-injected on-disk
  // path (the two real-file test suites: state-shutdown.unit.test.ts,
  // migrations-wiring.it.test.ts) is still a test fixture whose `afterEach`
  // only calls `closeDatabase()` directly (not `shutdownHistory()`), so any
  // gate that spawned a subprocess for those paths would silently LEAK a real
  // child process on every single test run (confirmed empirically: a `ps aux`
  // during `bun run test:backend` showed an orphaned `history-search-daemon`
  // still running after the whole suite finished). The retired in-process
  // engine's `enabled: dbPath !== ":memory:"` gate was safe there because
  // "enabled" only meant "write to an on-disk index directory" — no OS-level
  // resource was ever left running past `closeDatabase()`. Spawning a real
  // process is not equivalent risk and must not reuse that gate.
  await stopHistorySearchSupervisor()
  if (!state.historyDbPath) {
    historySearchSupervisor = createHistorySearchSupervisor({
      dbPath,
      indexPath: PATHS.HISTORY_SEARCH_DIR,
      socketPath: PATHS.HISTORY_SEARCH_SOCKET,
    })
    historySearchSupervisor.start()
  }
  unsubscribeRawCapture?.()
  unsubscribeRawCapture = onHistoryRawCaptureChange(() => {
    configureRawCapture({
      enabled: state.historyRawCaptureEnabled,
      dbPath: state.historyRawCaptureDbPath || PATHS.HISTORY_RAW_DB,
      maxObjectBytes: state.historyRawCaptureMaxObjectBytes,
    })
  })
  // DB-health (Phase 4b): periodic checkpoint/incremental-vacuum/optimize tick,
  // adopted from the retired V2 reaper tick's maintenance half (see
  // v3/maintenance.ts doc comment for what was and wasn't carried over).
  // Idempotent restart — reopening History (e.g. a config reload) restarts the
  // timer at a fresh interval rather than stacking a second one.
  startV3Maintenance()
}

/**
 * Stop history BACKGROUND work WITHOUT closing the DB (graceful Phase 1).
 *
 * The DB must stay open through Phase 2/3 request drain: a request completing
 * during drain triggers an ASYNC finalize (RFC history-finalize-async-offload),
 * which writes to the DB after this point. Closing here (the pre-refactor
 * behavior) would make every such finalize hit a dead handle and lose the entry
 * (§4.1 CRITICAL). The DB is closed later by `shutdownHistory`, invoked from the
 * shutdown `finalize()` step AFTER drain.
 *
 * Stops the reaper + backfill so no new background writes start, but leaves
 * `enabled` true so in-flight finalizes still persist.
 *
 * Deliberately does NOT stop the history-search supervisor — the sidecar reads
 * ALREADY-COMMITTED rows over its own readonly connection; unlike the retired
 * in-process engine, there is no in-process search work here to drain, and a
 * request settling during Phase 2/3 drain does not depend on the sidecar being
 * up. The supervisor is stopped later, in `shutdownHistory`, alongside DB close.
 */
export function stopHistoryBackgroundWork(): void {
  unsubscribeRawCapture?.()
  unsubscribeRawCapture = undefined
  stopV3Maintenance()
  stopV3SummaryBackfill()
  // Signal the background backfills to stop BEFORE the DB closes (each saves its
  // cursor per batch and resumes on next start — a post-close prepare would throw).
}

/**
 * Final history teardown (graceful `finalize()` step, AFTER request drain):
 * drain the canonical V3 terminal-write pipeline, THEN close the DB. The V2
 * async-finalize drain (`drainPendingFinalizations`/`retryPendingFinalizations`)
 * was removed with the V2 write chain (History V2 removal Phase 3) — its
 * mechanism (transient-retain/tombstone-degrade on a failed `finalizeEntry`)
 * had no production caller (the deleted `HistorySink` was the only one). The
 * V3 terminal-bus subscriber (`subscribeModelOperationTerminals`, wired in
 * `initHistory` below) is the sole production persistence path and drains via
 * `drainModelOperationTerminalSubscribers` + `drainV3Writer` — unsubscribe
 * FIRST (stop accepting new terminal records), then drain the subscriber
 * queue, then drain the writer's own pending/in-flight commits, THEN close.
 * Async; awaited by the shutdown sequence before process exit.
 *
 * The history-search supervisor is stopped (SIGTERM its sidecar, escalating to
 * SIGKILL) AFTER the V3 writer has fully drained — the sidecar only ever reads
 * already-committed rows over its own readonly connection, so there is no
 * ordering dependency the other direction; stopping it here (not earlier, in
 * `stopHistoryBackgroundWork`) simply keeps every teardown of history's own
 * resources colocated in this one function.
 */
export async function shutdownHistory(): Promise<void> {
  // Idempotent: a direct call (tests / non-graceful paths) must also stop background work.
  stopHistoryBackgroundWork()
  // Keep the canonical terminal subscriber alive through request drain. Only
  // detach after no more requests can settle, then drain terminal work to disk.
  unsubscribeV3Terminal?.()
  unsubscribeV3Terminal = undefined
  await drainModelOperationTerminalSubscribers()
  await drainV3Writer()
  await stopHistorySearchSupervisor()
  await drainV3SummaryBackfill()
  shutdownRawCapture()
  closeDatabase()
  enabled = false
}

/** History V3 does not run V2 backfills or migrate a legacy history database. */
export function startHistoryBackfills(): void {
  if (!enabled) return
  // Additive V3 projection maintenance only. This never opens or reads legacy
  // history.db/archive artifacts and never rewrites canonical V3 records.
  startV3SummaryBackfill(getDatabase())
}
