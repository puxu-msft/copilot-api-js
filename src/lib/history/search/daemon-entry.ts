/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3′ — the sidecar's process entry point AND its own first-class, operator-
 * facing service command (`history-search-daemon`). Unlike the retired Phase 3
 * design, this is NOT a hidden spawn target for a main-process supervisor — the
 * 2026-07-21 architecture revision (see the plan doc's header) made the sidecar a
 * genuinely INDEPENDENT, separately-started service (systemd `Restart=on-failure`,
 * or any other process manager, or a bare foreground run) with no parent process
 * of its own. An operator runs it directly, typically via systemd
 * (contrib/systemd/history-search.service).
 *
 * Runs the full sidecar lifecycle in THIS process, deliberately isolated from
 * the main server process:
 *   tail loop (periodic `daemon.tailOnce()`, debounced `index.flush()`)
 *     + UDS server (`uds-server.ts`, serving `daemon.search`)
 *     + graceful SIGTERM/SIGINT shutdown (flush -> close index -> close daemon
 *       -> close UDS server, unlinking the socket file)
 *
 * A native Tantivy `abort()` (a Rust panic that unwinds through the N-API
 * boundary) cannot be caught by ANY JS try/catch or process signal handler --
 * this is the exact failure mode the whole out-of-process design exists to
 * contain. This module's own crash-safety code only protects against ordinary
 * JS-level failures (a thrown search error, a socket reset); a native abort
 * simply kills THIS process outright, and restart is entirely systemd's job
 * (`Restart=on-failure` + `RestartSec=`) -- there is no in-process supervisor
 * anymore to observe or react to it.
 *
 * Default args deliberately mirror the main process's own PATHS constants
 * (HISTORY_V3_DB / HISTORY_SEARCH_DIR / HISTORY_SEARCH_SOCKET) so `bun run
 * <entry> history-search-daemon` with ZERO flags talks to the exact same
 * on-disk db and socket path the main process's UDS client (state.ts) reads --
 * both sides derive the socket path from the SAME shared constant
 * (`PATHS.HISTORY_SEARCH_SOCKET`), never from independently-typed strings that
 * could drift out of sync.
 */

import { defineCommand } from "citty"
import consola from "consola"

import type { HistorySearchWireStatus } from "~/lib/history/search/protocol"

import { PATHS } from "~/lib/config/paths"
import { getNativeHistorySearch } from "~/lib/history/search-native"
import {
  //
  createHistorySearchDaemon,
  type HistorySearchDaemon,
} from "~/lib/history/search/daemon"
import {
  //
  createHistorySearchUdsServer,
  type HistorySearchUdsServer,
} from "~/lib/history/search/uds-server"

/** Cadence for tail rounds — independent of (and much more frequent than) the flush
 *  debounce below, since tailing just upserts into the in-memory writer buffer
 *  (cheap); only `flush()` commits a Tantivy segment (the expensive operation the
 *  in-process incident's segment-explosion fix batches). */
const TAIL_INTERVAL_MS = 1_000
/** Debounced flush cadence — mirrors the retired in-process `search-tantivy.ts`'s
 *  FLUSH_IDLE_MS/FLUSH_MAX_OPS/FLUSH_MAX_MS batching (the fix for the per-request
 *  segment-explosion incident this whole plan follows on from). */
const FLUSH_IDLE_MS = 3_000
const FLUSH_MAX_OPS = 200
const FLUSH_MAX_MS = 30_000

export interface RunHistorySearchDaemonOptions {
  dbPath: string
  socketPath: string
  indexPath: string
}

/**
 * Run the sidecar process body until a shutdown signal arrives. Exported (not
 * just wired into the citty command's `run`) so `tests/history/search/daemon-
 * entry.it.test.ts` can drive it in-process against a short-lived AbortSignal
 * instead of needing a real OS process per test case — the citty command
 * wrapper (`historySearchDaemonCommand` below) is the thin, untested-by-design
 * process-lifecycle shim; ALL the actual logic lives here.
 */
export async function runHistorySearchDaemon(options: RunHistorySearchDaemonOptions, signal: AbortSignal): Promise<void> {
  const native = await getNativeHistorySearch()
  const index = new native.HistoryIndex(options.indexPath)
  const daemon: HistorySearchDaemon = createHistorySearchDaemon({ dbPath: options.dbPath, indexPath: options.indexPath, index })

  // Tail-progress status (merged-state review blocker 3, 2026-07-22): a pure UDS
  // reachability ping (`pingHistorySearchUdsClient`) hits the native short-circuit
  // and answers instantly regardless of whether the tail loop is actually making
  // progress -- an operator could see `reachable: true` forever while the sidecar
  // is wedged (e.g. on a permanently-poisoned row that keeps throwing at the ROUND
  // level, not just the per-row level B1 already isolates -- a genuine infra fault
  // like the readonly db handle itself failing to open). These three fields are
  // the sidecar's own honest self-report, read synchronously by the UDS server's
  // `getStatus` callback below (no I/O, just counters this closure already owns).
  let lastSuccessfulTailAt: number | null = null
  let poisonedCount = 0
  let lastTailError: string | null = null
  function getStatus(): HistorySearchWireStatus["status"] {
    return { lastSuccessfulTailAt, poisonedCount, lastTailError }
  }

  const server: HistorySearchUdsServer = createHistorySearchUdsServer(options.socketPath, daemon.search, getStatus)

  let uncommitted = 0
  let firstUncommittedAt: number | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let tailTimer: ReturnType<typeof setTimeout> | undefined
  let tailInFlight = false
  let flushInFlight: Promise<void> | undefined

  function clearFlushTimer(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
  }

  function enqueueFlush(): void {
    clearFlushTimer()
    if (uncommitted === 0) return
    uncommitted = 0
    firstUncommittedAt = undefined
    flushInFlight = index.flush().catch((error: unknown) => {
      consola.error("[history-search-daemon] flush failed", error)
    })
  }

  function scheduleFlush(): void {
    if (uncommitted === 0) return
    const sinceFirst = firstUncommittedAt === undefined ? 0 : Date.now() - firstUncommittedAt
    if (uncommitted >= FLUSH_MAX_OPS || sinceFirst >= FLUSH_MAX_MS) {
      enqueueFlush()
      return
    }
    clearFlushTimer()
    flushTimer = setTimeout(enqueueFlush, FLUSH_IDLE_MS)
    flushTimer.unref()
  }

  async function tailTick(): Promise<void> {
    if (tailInFlight || signal.aborted) return
    tailInFlight = true
    try {
      const result = await daemon.tailOnce()
      // A round completing AT ALL (even zero new rows) is the "tail loop itself is
      // alive" signal -- distinct from `result.processed`, which is legitimately 0
      // most rounds (nothing new committed since the last tick).
      lastSuccessfulTailAt = Date.now()
      lastTailError = null
      poisonedCount += result.poisoned
      if (result.processed > 0) {
        uncommitted += result.processed
        firstUncommittedAt ??= Date.now()
        scheduleFlush()
      }
    } catch (error) {
      // A ROUND-level throw here is now reserved for genuine infra faults (the
      // readonly db handle itself failing, a native index write erroring out) --
      // per-row poison isolation (B1, daemon.ts) already prevents a bad manifest
      // from ever reaching this catch. `lastSuccessfulTailAt` deliberately does NOT
      // advance here -- an operator polling status sees it grow stale, the honest
      // signal that tailing has actually stopped making progress.
      lastTailError = error instanceof Error ? error.message : String(error)
      consola.error("[history-search-daemon] tail round failed", error)
    } finally {
      tailInFlight = false
    }
  }

  function scheduleTail(): void {
    if (signal.aborted) return
    tailTimer = setTimeout(() => {
      void tailTick().finally(scheduleTail)
    }, TAIL_INTERVAL_MS)
    tailTimer.unref()
  }

  await server.listen()
  await tailTick() // catch up fully before declaring "ready" — the first request should not race an empty index
  scheduleTail()

  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })

  // Graceful shutdown: stop scheduling new work, flush whatever is staged, THEN
  // release resources in dependency order (index before daemon's own db handle,
  // daemon before the server so no in-flight request the daemon might still be
  // serving through `daemon.search` is torn down under it).
  if (tailTimer !== undefined) clearTimeout(tailTimer)
  clearFlushTimer()
  enqueueFlush()
  await flushInFlight
  await index.close()
  daemon.close()
  await server.close()
}

export const historySearchDaemonCommand = defineCommand({
  meta: {
    name: "history-search-daemon",
    description:
      "Run the independent history-search sidecar service — tails history-v3.db readonly, "
      + "builds a Tantivy full-text index, and serves search queries over a Unix domain socket. "
      + "Run this as its own long-lived process (e.g. via systemd, see contrib/systemd/history-search.service); "
      + "the main `start` server never spawns or supervises it — it is an optional independent service, "
      + "and the main process degrades to empty search results whenever it is not reachable.",
  },
  args: {
    db: {
      type: "string",
      default: PATHS.HISTORY_V3_DB,
      description: `Path to history-v3.db to tail readonly (default: ${PATHS.HISTORY_V3_DB}, the same on-disk db the main process writes)`,
    },
    socket: {
      type: "string",
      default: PATHS.HISTORY_SEARCH_SOCKET,
      description: `UDS socket path to serve search queries on (default: ${PATHS.HISTORY_SEARCH_SOCKET}, the same path the main process's UDS client reads)`,
    },
    index: {
      type: "string",
      default: PATHS.HISTORY_SEARCH_DIR,
      description: `Tantivy index directory, also holds the tail cursor (default: ${PATHS.HISTORY_SEARCH_DIR})`,
    },
  },
  async run({ args }) {
    const controller = new AbortController()
    const onSignal = (): void => controller.abort()
    process.on("SIGTERM", onSignal)
    process.on("SIGINT", onSignal)
    try {
      consola.info(`[history-search-daemon] starting -- db=${args.db} socket=${args.socket} index=${args.index}`)
      await runHistorySearchDaemon({ dbPath: args.db, socketPath: args.socket, indexPath: args.index }, controller.signal)
      consola.info("[history-search-daemon] shut down cleanly")
    } finally {
      process.off("SIGTERM", onSignal)
      process.off("SIGINT", onSignal)
    }
  },
})
