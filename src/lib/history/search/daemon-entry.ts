/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3 — the sidecar PROCESS ENTRY POINT. This is what `supervisor.ts` spawns
 * (`<execPath> <entryPath> history-search-daemon --db ... --socket ... --index ...`)
 * as its own OS process, hidden behind an undocumented citty sub-command (no
 * `description`, so it never shows in `--help`'s command list) — an operator is
 * not meant to invoke this directly; it exists purely as the supervisor's spawn
 * target.
 *
 * Runs the full sidecar lifecycle in THIS process, deliberately isolated from
 * the main server process:
 *   tail loop (periodic `daemon.tailOnce()`, debounced `index.flush()`)
 *     + UDS server (`uds-server.ts`, serving `daemon.search`)
 *     + graceful SIGTERM/SIGINT shutdown (flush -> close index -> close daemon
 *       -> close UDS server, unlinking the socket file)
 *
 * A native Tantivy `abort()` (a Rust panic that unwinds through the N-API
 * boundary) cannot be caught by ANY JS try/catch or process signal handler —
 * this is the exact failure mode the whole out-of-process design exists to
 * contain. This module's own crash-safety code only protects against
 * ordinary JS-level failures (a thrown search error, a socket reset); the
 * native-abort case is handled ENTIRELY by `supervisor.ts` observing this
 * process's exit and deciding whether/when to restart it — never by anything
 * in this file, which cannot see its own abort coming.
 */

import { defineCommand } from "citty"
import consola from "consola"

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
  const server: HistorySearchUdsServer = createHistorySearchUdsServer(options.socketPath, daemon.search)

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
      if (result.processed > 0) {
        uncommitted += result.processed
        firstUncommittedAt ??= Date.now()
        scheduleFlush()
      }
    } catch (error) {
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
    // No `description` -- deliberately absent from --help's rendered command
    // list (an operator is not meant to invoke this directly; it exists only
    // as supervisor.ts's spawn target).
  },
  args: {
    db: { type: "string", required: true, description: "Path to history-v3.db to tail readonly" },
    socket: { type: "string", required: true, description: "UDS socket path to serve search queries on" },
    index: { type: "string", required: true, description: "Tantivy index directory (also holds the tail cursor)" },
  },
  async run({ args }) {
    const controller = new AbortController()
    const onSignal = (): void => controller.abort()
    process.on("SIGTERM", onSignal)
    process.on("SIGINT", onSignal)
    try {
      await runHistorySearchDaemon({ dbPath: args.db, socketPath: args.socket, indexPath: args.index }, controller.signal)
    } finally {
      process.off("SIGTERM", onSignal)
      process.off("SIGINT", onSignal)
    }
  },
})
