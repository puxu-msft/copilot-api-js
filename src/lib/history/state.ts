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
import { setHistorySearchClient } from "./search/client-registry"
import { createHistorySearchUdsClient } from "./search/uds-client"
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
  enqueueModelOperationWithOutcome,
  ensureV3Schema,
  recoverV3Journal,
  startV3SummaryBackfill,
  stopV3SummaryBackfill,
} from "./v3/store"
import {
  //
  clearRecentModelOperationTerminalsForTests,
  drainModelOperationTerminalSubscribers,
  settleRecentModelOperationDurability,
  subscribeModelOperationTerminals,
} from "./v3/terminal-bus"

let enabled = false
let unsubscribeV3Terminal: (() => void) | undefined
let unsubscribeRawCapture: (() => void) | undefined
let _publisher: ScopedPublisher<"history"> | undefined

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
 * The main process's UDS client for the (independent, out-of-process)
 * history-search sidecar service, when History is enabled (undefined when
 * disabled — see `historySearchClient`'s doc comment). Read by
 * `status/route.ts` (`history_search` reachability status) and (future
 * Phase 4) the REST search handler.
 */
export { getHistorySearchClient } from "./search/client-registry"

export function setHistorySearchClientForTests(client: Parameters<typeof setHistorySearchClient>[0]): void {
  setHistorySearchClient(client)
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

export async function initHistory(enable: boolean, _legacyMaxEntries?: number): Promise<void> {
  clearInFlight()
  clearRecentModelOperationTerminalsForTests()
  enabled = enable
  if (!enable) {
    unsubscribeV3Terminal?.()
    unsubscribeV3Terminal = undefined
    setHistorySearchClient(undefined)
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
  unsubscribeV3Terminal = subscribeModelOperationTerminals(async (record) => {
    const outcome = await enqueueModelOperationWithOutcome(record)
    settleRecentModelOperationDurability(record, outcome)
  })
  // History-search sidecar (Phase 3′): construct ONLY the UDS client — never
  // spawn/supervise a process. The client is a lightweight, stateless-per-
  // query object (see uds-client.ts); constructing it unconditionally here
  // costs nothing and requires no gate on `historyDbPath`/`:memory:` the way
  // the retired spawn-based design did (that gate existed ONLY to avoid
  // leaking a real spawned OS process from test runs — a concern that does
  // not exist anymore since nothing is spawned). Both this client and the
  // independently-started sidecar service read the SAME `PATHS.
  // HISTORY_SEARCH_SOCKET` constant, so they agree on the socket path without
  // any parameter-passing between the two independently-lifecycled processes.
  setHistorySearchClient(createHistorySearchUdsClient({ socketPath: PATHS.HISTORY_SEARCH_SOCKET }))
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
 * The history-search UDS client needs no explicit shutdown step — it is
 * stateless per query (each `query()` opens and closes its own short-lived
 * connection, see uds-client.ts), so there is nothing to drain/stop; it is
 * simply discarded along with everything else when History disables.
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
  setHistorySearchClient(undefined)
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
