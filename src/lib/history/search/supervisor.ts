/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3 — main-process supervisor. Spawns the sidecar as a genuinely separate
 * OS process (`history-search-daemon`, `daemon-entry.ts`), restarts it on crash
 * with capped exponential backoff, gives up after a bounded run of rapid
 * restarts (crash-loop protection), and owns the UDS client the REST layer will
 * query (P4).
 *
 * THIS is where the whole plan's crash-isolation guarantee is actually cashed
 * in: a native Tantivy `abort()` (Rust panic through the N-API boundary) kills
 * the SIDECAR process outright — something no JS try/catch anywhere could ever
 * intercept — but the sidecar is a genuinely separate OS process with its own
 * address space, so the abort is physically incapable of touching the main
 * process. The supervisor's job is purely to notice the exit and react.
 */

import consola from "consola"
import {
  //
  spawn,
  type ChildProcess,
} from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import {
  //
  createHistorySearchUdsClient,
  type HistorySearchUdsClient,
} from "./uds-client"

/** Sub-command name `daemon-entry.ts`'s citty command registers under (kept as a
 *  named constant so supervisor.ts and main.ts's subCommands wiring can never drift). */
export const HISTORY_SEARCH_DAEMON_SUBCOMMAND = "history-search-daemon"

const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
/** A restart is counted as "rapid" (crash-loop signal) when the child's own uptime
 *  before exiting was under this threshold — a sidecar that ran fine for an hour and
 *  then happened to be killed once is NOT a crash loop; one that dies within a second
 *  of every restart is. */
const RAPID_EXIT_THRESHOLD_MS = 2_000
/** After this many CONSECUTIVE rapid exits, stop auto-restarting and surface
 *  `abandoned: true` — a persistently malformed input (a poison record) must not
 *  burn CPU/log volume in an infinite restart loop. */
const MAX_CONSECUTIVE_RAPID_EXITS = 5
/** Grace period given to a SIGTERM'd child before escalating to SIGKILL. */
const SIGTERM_GRACE_MS = 3_000

export interface HistorySearchSupervisorOptions {
  dbPath: string
  socketPath: string
  indexPath: string
}

export interface HistorySearchSupervisorStatus {
  /** True once the sidecar's UDS server has been confirmed reachable at least once
   *  since the last (re)spawn — NOT merely "a child process object exists" (a spawned
   *  process that immediately crashes before ever listening was never really "alive"
   *  from a caller's perspective). */
  alive: boolean
  /** Consecutive rapid-exit count since the last successful (non-rapid) run. */
  consecutiveRapidExits: number
  /** True once `MAX_CONSECUTIVE_RAPID_EXITS` has been reached — auto-restart has
   *  stopped; only a fresh `start()` call (e.g. a future config reload) resumes it. */
  abandoned: boolean
  /** The child's OS pid, when currently running. */
  pid?: number
}

export interface HistorySearchSupervisor {
  /** Spawn the sidecar and begin supervising it. Idempotent — a second call while
   *  already running is a no-op. */
  start: () => void
  /** Stop supervising (no further auto-restart) and gracefully terminate the current
   *  child (SIGTERM, escalating to SIGKILL after `SIGTERM_GRACE_MS`). Resolves once the
   *  child has actually exited. Safe to call when nothing is running. */
  stop: () => Promise<void>
  getStatus: () => HistorySearchSupervisorStatus
  /** The UDS client bound to this supervisor's `socketPath` — constructed once,
   *  reused across every sidecar restart (the client is stateless per-query, so a
   *  restart never invalidates it; see uds-client.ts). */
  client: HistorySearchUdsClient
}

/**
 * Resolve the entry SCRIPT this process itself was started from — dev
 * (`bun run src/main.ts` / `bun --watch src/main.ts`) resolves to `src/main.ts`
 * relative to THIS module's own location; a packaged install (`node dist/main.mjs`,
 * the `bin` target in package.json) resolves to `dist/main.mjs`, since tsdown
 * bundles this file INTO `dist/main.mjs` (there is no separate `dist/history/
 * search/supervisor.mjs` — bundling collapses every source module's `import.meta.
 * dirname` to `dist/` for every module in the bundle). Mirrors the existing
 * dev-vs-packaged split in `src/lib/config/paths.ts`'s `locateBundledConfig` and
 * `src/routes/ui/route.ts`'s `resolveUiDir` (same problem, same "try both
 * candidates, prefer whichever exists on disk" resolution).
 */
export function resolveEntryPath(): string {
  const packagedCandidate = path.join(import.meta.dirname, "main.mjs") // dist/main.mjs (bundled)
  const devCandidate = path.resolve(import.meta.dirname, "../../../main.ts") // src/main.ts (dev checkout)
  // Check the DEV candidate first: a real npm/published install only ever ships
  // `dist/` (package.json's `files`), so `src/main.ts` genuinely does not exist
  // there and the packaged branch is the only one that can ever match in that
  // case. In a dev checkout, though, `dist/` is very likely ALSO built (from a
  // previous `bun run build`) — so both candidates can exist simultaneously, and
  // it is the dev one that reflects what THIS running process (a `bun run
  // src/main.ts` invocation) was actually started from; it must win whenever
  // present, rather than the check order coincidentally picking the stale
  // bundled copy instead.
  if (existsSync(devCandidate)) return devCandidate
  if (existsSync(packagedCandidate)) return packagedCandidate
  throw new Error(
    `[history-search-supervisor] could not resolve an entry script from either dev (${devCandidate}) or packaged (${packagedCandidate}) candidates`,
  )
}

function backoffMs(consecutiveFailures: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS)
}

/** Construct (but do not yet start) a supervisor for the given sidecar paths. */
export function createHistorySearchSupervisor(options: HistorySearchSupervisorOptions): HistorySearchSupervisor {
  const rawClient = createHistorySearchUdsClient({ socketPath: options.socketPath })

  let running = false
  let child: ChildProcess | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let alive = false
  let consecutiveRapidExits = 0
  let abandoned = false

  function clearRestartTimer(): void {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
  }

  function spawnChild(): void {
    if (!running || abandoned) return
    const entryPath = resolveEntryPath()
    const spawnedAt = Date.now()
    const proc = spawn(
      process.execPath,
      [entryPath, HISTORY_SEARCH_DAEMON_SUBCOMMAND, "--db", options.dbPath, "--socket", options.socketPath, "--index", options.indexPath],
      { stdio: ["ignore", "inherit", "inherit"] },
    )
    child = proc
    alive = false // not confirmed alive until an actual query succeeds — see the wrapped `query` below

    // `error` here means the spawn itself failed (ENOENT executable, EACCES, etc.) —
    // an unlistened `error` on a ChildProcess (also an EventEmitter) would otherwise
    // surface as this (the MAIN) process's uncaughtException, exactly the
    // crash-amplification chain [[debugging-server-crashes]] warns about, except this
    // time hitting the very process the whole plan protects.
    proc.on("error", (error) => {
      consola.error("[history-search-supervisor] failed to spawn sidecar", error)
    })

    proc.on("exit", (code, signal) => {
      if (child === proc) child = undefined
      alive = false
      if (!running) return // stop() already tore this down; do not react to its own SIGTERM
      const uptimeMs = Date.now() - spawnedAt
      const rapid = uptimeMs < RAPID_EXIT_THRESHOLD_MS
      consecutiveRapidExits = rapid ? consecutiveRapidExits + 1 : 0
      consola.warn(
        `[history-search-supervisor] sidecar exited (code=${String(code)}, signal=${String(signal)}, uptime=${uptimeMs}ms)${rapid ? " — rapid exit" : ""}`,
      )
      if (consecutiveRapidExits >= MAX_CONSECUTIVE_RAPID_EXITS) {
        abandoned = true
        consola.error(
          `[history-search-supervisor] sidecar failed ${consecutiveRapidExits} times rapidly in a row — giving up automatic restarts (history_search will report degraded/unavailable until a future config reload)`,
        )
        return
      }
      clearRestartTimer()
      restartTimer = setTimeout(spawnChild, backoffMs(consecutiveRapidExits))
      restartTimer.unref()
    })
  }

  function start(): void {
    if (running) return
    running = true
    abandoned = false
    consecutiveRapidExits = 0
    spawnChild()
  }

  async function stop(): Promise<void> {
    running = false
    clearRestartTimer()
    const proc = child
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      child = undefined
      alive = false
      return
    }
    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(killTimer)
        resolve()
      }
      proc.once("exit", onExit)
      const killTimer = setTimeout(() => {
        // The child ignored SIGTERM (or is wedged) — escalate. A native abort mid-
        // teardown could ALSO land here; SIGKILL is unconditional either way.
        proc.kill("SIGKILL")
      }, SIGTERM_GRACE_MS)
      proc.kill("SIGTERM")
    })
    child = undefined
    alive = false
  }

  function getStatus(): HistorySearchSupervisorStatus {
    return {
      alive,
      consecutiveRapidExits,
      abandoned,
      ...(child?.pid !== undefined && { pid: child.pid }),
    }
  }

  // The supervisor's own status view of `alive` is confirmed ONLY by an actual
  // successful round-trip through the CURRENTLY-running child — a lightweight,
  // best-effort liveness signal derived from real traffic (P4's REST layer),
  // never a proactive health-check query of its own. Wrapping here (rather than
  // mutating `rawClient.query` after construction) keeps `uds-client.ts` itself
  // fully unaware of the supervisor that may sit above it.
  const client: HistorySearchUdsClient = {
    query: async (...args) => {
      const rows = await rawClient.query(...args)
      if (child !== undefined && child.exitCode === null && child.signalCode === null) alive = true
      return rows
    },
  }

  return { start, stop, getStatus, client }
}
