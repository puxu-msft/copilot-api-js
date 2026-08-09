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
import { openDatabaseReadonly } from "./sqlite/connection"
import {
  //
  closeHistoryReadDatabase,
  installHistoryReadDatabase,
  peekHistoryReadDatabase,
} from "./sqlite/read-connection"
import { V3_MAINTENANCE_INTERVAL_MS } from "./v3/maintenance"
import { getV3PersistRetryConfig } from "./v3/store"
import {
  //
  clearRecentModelOperationTerminalsForTests,
  drainModelOperationTerminalSubscribers,
  settleRecentModelOperationDurability,
  subscribeModelOperationTerminals,
} from "./v3/terminal-bus"
import { HISTORY_WORKER_PROTOCOL_VERSION } from "./worker/protocol"
import {
  //
  getHistoryAdmissionController,
  getHistoryPersistenceRuntime,
  peekHistoryPersistenceRuntime,
  releaseHistoryPersistenceRuntime,
} from "./worker/registry"

let enabled = false
/**
 * Semantic DB path this thread has already brought up (Worker started + readonly handle installed), or `undefined` when nothing is installed.
 *
 * `initHistory` has always been idempotent — the pre-cutover version relied on `openDatabase()` returning the live handle when the path was unchanged (`connection.ts`), and `resetTestRuntime` calls it on every test. The cutover replaced that one reopen with two installations that are BOTH single-shot: `runtime.start()` rejects an already-started runtime, and `installHistoryReadDatabase` refuses to shadow a live handle. This variable carries the same idempotency across the new pair, and is keyed by path so a caller that switches artifacts still gets a real re-open instead of silently keeping the previous one.
 */
let startedDbPath: string | undefined
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
    // No main-thread write handle to close any more; the Worker owns it and is torn down
    // by `shutdownHistory`. Only this thread's readonly handle is ours to release.
    shutdownRawCapture()
    closeHistoryReadDatabase()
    startedDbPath = undefined
    return
  }
  // `historyDbPath` is retained only as an injected test seam during the V3
  // cutover. Production config cannot set it; the default is a physically
  // separate V3 artifact, so opening History never mutates legacy history.db.
  const dbPath = state.historyDbPath || PATHS.HISTORY_V3_DB
  // Re-entry against the SAME artifact re-wires the subscriptions below but must NOT try to install the Worker or the readonly handle a second time — both reject that, and the old `openDatabase()` this replaced treated an unchanged path as a no-op reopen.
  //
  // "Already installed" is deliberately THREE conditions, not one. The path answers "same artifact?"; `peekHistoryPersistenceRuntime()` answers "is the thing I started still the registry's runtime?"; `peekHistoryReadDatabase()` answers "is my readonly handle still published?". Each of the latter two can be taken away independently — a runtime is single-use, so releasing the singleton (a `historyDbPath` switch, `shutdownHistory`, the per-test injector reset that keeps a mocked runtime from leaking) leaves this thread believing it is up while its writer is gone, and a test that publishes its own handle through `openInMemoryDatabase()` detaches ours. Reading the registries instead of trusting our own flag makes re-init self-healing rather than dependent on the caller's teardown order.
  const alreadyInstalled = startedDbPath === dbPath && peekHistoryPersistenceRuntime() !== undefined && peekHistoryReadDatabase() !== undefined
  if (!alreadyInstalled) {
    // Release whatever a previous bring-up left behind before installing again: a readonly handle on the old artifact, and a runtime that is either pointed at the old path or already dead.
    closeHistoryReadDatabase()
    await releaseHistoryPersistenceRuntime()
    startedDbPath = undefined
    // CUTOVER (Batch 2b): the Worker now owns the semantic WRITE connection exclusively.
    // Everything the main thread used to do here — open, schema reconcile, forward
    // migrations, journal recovery — happens inside `initialize` on the Worker thread, which
    // is the whole point: those are the synchronous blocks that used to freeze the proxy's
    // event loop. Spec §8.1 fixes this order, and the readonly handle below may only be
    // opened after `ready`, because the artifact and its owner marker are the Worker's to
    // create.
    const runtime = getHistoryPersistenceRuntime()
    await runtime.start({
      semanticDbPath: dbPath,
      configRevision: 1,
      // Raw capture stays on the main thread until Batch 3b. The Worker must NOT open the
      // same raw artifact concurrently, so it starts with raw disabled.
      rawConfig: { enabled: false, dbPath: "", maxObjectBytes: state.historyRawCaptureMaxObjectBytes },
      persistRetry: getV3PersistRetryConfig(),
      maintenanceIntervalMs: V3_MAINTENANCE_INTERVAL_MS,
    })
    // §8.1 step 8: the main thread's own connection is READONLY from here on. Every query
    // path below reads through it; nothing on this thread may write the semantic DB again.
    installHistoryReadDatabase(openDatabaseReadonly(dbPath))
    startedDbPath = dbPath
  }
  const admission = getHistoryAdmissionController()
  // The registry singleton, not a local from the branch above: on an idempotent re-entry that branch never ran, and the sink must still point at the runtime that is actually installed.
  admission.replaceTerminalSink(getHistoryPersistenceRuntime())
  unsubscribeV3Terminal?.()
  unsubscribeV3Terminal = subscribeModelOperationTerminals(async (publication) => {
    const outcome = await admission.acceptTerminal({ protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, publication })
    settleRecentModelOperationDurability(publication, outcome)
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
  // Maintenance and summary backfill live on the Worker now, so "stop background work"
  // is a message rather than a local timer clear. §8.2 step 4: stop claiming new units,
  // finish the one already claimed — the Worker awaits that before answering.
  void peekHistoryPersistenceRuntime()?.stopMaintenance()
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
  // §8.2 step 5: wait for every un-ACKed persistence item to reach a terminal outcome,
  // then close the Worker (step 7). `drain()` replaces the old in-process `drainV3Writer()`
  // — the writer is not on this thread any more, so awaiting a local queue would prove
  // nothing about what actually reached disk.
  const runtime = peekHistoryPersistenceRuntime()
  if (runtime) {
    await runtime.drain()
    await runtime.shutdown()
  }
  setHistorySearchClient(undefined)
  shutdownRawCapture()
  closeHistoryReadDatabase()
  startedDbPath = undefined
  enabled = false
}

/** History V3 does not run V2 backfills or migrate a legacy history database. */
export function startHistoryBackfills(): void {
  if (!enabled) return
  // Additive V3 projection maintenance only. The Worker starts the summary backfill from
  // its own `initialize` (it is a WRITE, and the write handle lives there now), so this
  // main-thread entry point has nothing left to start.

}
