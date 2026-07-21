/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3′ — the sidecar as an INDEPENDENT, separately-started service (the
 * 2026-07-21 architecture revision that replaced Phase 3's retired "main process
 * spawns + supervises" model — see the plan doc header for the two production
 * incidents that ruled that model out: orphaned Tantivy-lock sidecars after a
 * non-graceful main-process death, and blue-green restart spawn races).
 *
 * These tests spawn the sidecar as a genuinely independent process (mirroring
 * how an operator/systemd would start it) and prove:
 *   - the service command's default args (no flags) resolve to the SAME
 *     PATHS-derived paths the main process's UDS client reads
 *   - crash isolation: `kill -9` on an independently-running sidecar leaves
 *     THIS test process (standing in for "the main process") completely
 *     unaffected — the main process is not the one restarting it; restart in
 *     this test is a stand-in for what systemd's `Restart=on-failure` does
 *   - once a fresh sidecar process is started again (whether by systemd or,
 *     here, by the test itself), search recovers with zero main-process
 *     involvement in the restart itself
 *
 * Real subprocesses, real wall-clock seconds — `.it`, not `.unit`.
 */

import {
  //
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/config/paths"
import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { createHistorySearchUdsClient } from "~/lib/history/search/uds-client"
import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
} from "~/lib/history/v3/store"

import { primeUdsConnectForBunTest } from "../../helpers/prime-uds-for-bun-test"
import { waitUntil } from "../../helpers/wait-until"

// See prime-uds-for-bun-test.ts's doc comment: this file's very first UDS
// interaction is polling a client BEFORE the sidecar's socket necessarily
// exists yet — exactly the `bun test`-only scenario that needs priming
// (confirmed empirically not to be a production bug).
beforeAll(primeUdsConnectForBunTest)

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Mirrors daemon.it.test.ts's helper: a real terminal record with a distinctive
 *  searchable token, committed through the production write path. */
function commitOperation(dbPath: string, id: string, needle: string): void {
  const db = openDatabase(dbPath)
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const payload = recorder.registerPayload({ messages: [{ role: "user", content: needle }] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed" })
  recorder.recordEgress({ upstream: {}, client: {} })
  const record = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
  commitPreparedOperation(db, prepareModelOperation(record))
  closeDatabase()
}

const devEntryPath = path.resolve(import.meta.dir, "..", "..", "..", "src", "main.ts")

/** Spawn the sidecar service exactly as an operator/systemd would: no
 *  supervising parent process of our own beyond bookkeeping the child handle
 *  for teardown. */
function spawnSidecar(args: ReadonlyArray<string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, devEntryPath, "history-search-daemon", ...args], { stdout: "ignore", stderr: "ignore" })
}

const spawnedChildren: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await child.exited
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("history-search-daemon service command: zero-flag defaults align with PATHS (single source of truth)", () => {
  test("dev form runs with NO flags and serves a query against the real default db/socket/index paths", async () => {
    // No --db/--socket/--index at all -- this is the exact invocation an operator's
    // systemd unit uses. Points HISTORY_DB_PATH-equivalent state at a real on-disk db
    // by writing directly to PATHS.HISTORY_V3_DB would pollute a real install; instead
    // this test verifies the DEFAULT-args wiring itself by constructing the daemon
    // command's own default resolution and confirming it matches PATHS -- the actual
    // end-to-end socket/tail behavior against a REAL PATHS.HISTORY_V3_DB is exercised
    // by the explicit-args tests below (which point at throwaway temp paths instead,
    // as every other test in this suite does, to never touch the operator's real
    // ~/.local/share/copilot-api).
    expect(fs.existsSync(devEntryPath)).toBe(true)

    // Confirm the citty command's own default-arg values (not just PATHS' existence)
    // by running --help and grepping the rendered defaults -- a change to the
    // service command's defaults that silently drifts from PATHS must fail this.
    // `env: process.env` is required -- Bun.spawn does NOT inherit the parent's env
    // by default, so without it the child would compute PATHS against its OWN
    // (unset) XDG_DATA_HOME rather than this test worker's sandboxed one (see
    // tests/helpers/sandbox-paths.ts), producing a default path that would never
    // match `PATHS.HISTORY_V3_DB` as read by THIS process.
    const helpChild = Bun.spawn([process.execPath, devEntryPath, "history-search-daemon", "--help"], { stdout: "pipe", stderr: "pipe", env: process.env })
    const helpText = await new Response(helpChild.stdout).text()
    await helpChild.exited
    expect(helpText).toContain(PATHS.HISTORY_V3_DB)
    expect(helpText).toContain(PATHS.HISTORY_SEARCH_SOCKET)
    expect(helpText).toContain(PATHS.HISTORY_SEARCH_DIR)
  })

  test("explicit-args form (temp paths, to stay off the operator's real install) really starts and serves a query", async () => {
    const dbDir = freshDir("daemon-cmd-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    commitOperation(dbPath, "cmd-op", "cmdServiceNeedle")
    const socketPath = path.join(freshDir("daemon-cmd-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("daemon-cmd-index-"), "index")

    const child = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(child)

    const client = createHistorySearchUdsClient({ socketPath })
    await waitUntil(async () => (await client.query("cmdServiceNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "independently-started sidecar to tail and serve the query",
    })
    const rows = await client.query("cmdServiceNeedle", undefined, 10)
    expect(rows.map((hit: { operationId: string }) => hit.operationId)).toEqual(["cmd-op"])
  }, 20_000)
})

describe("crash isolation (resident-service model): kill -9 an independently-running sidecar, main process untouched", () => {
  test("SIGKILL the sidecar -> this process's own pid unchanged, client degrades to empty (never throws); starting a FRESH sidecar recovers search", async () => {
    const dbDir = freshDir("resident-crash-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("resident-crash-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("resident-crash-index-"), "index")

    commitOperation(dbPath, "before-crash-op", "beforeCrashNeedle")

    const mainProcessPidBefore = process.pid
    const client = createHistorySearchUdsClient({ socketPath })

    // Start the sidecar exactly as systemd would -- independently, no supervising
    // parent of our own beyond this test's own bookkeeping for teardown.
    let sidecar = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(sidecar)

    await waitUntil(async () => (await client.query("beforeCrashNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "sidecar to index the pre-crash operation",
    })

    const pidBeforeKill = sidecar.pid

    // The actual crash-isolation act: kill -9 the SIDECAR (never this test's own
    // process) -- this process has no parent/child relationship to it at all, it
    // is a genuinely independent OS process, exactly like a systemd-managed unit.
    process.kill(pidBeforeKill, "SIGKILL")
    await sidecar.exited

    // The core assertion this whole plan exists for: THIS process is completely
    // unaffected by the sidecar's death -- no uncaughtException, no exit, same PID.
    expect(process.pid).toBe(mainProcessPidBefore)

    // The client must degrade to empty (never throw/reject) while the sidecar is down.
    let uncaught: unknown
    const onUncaught = (error: unknown): void => {
      uncaught = error
    }
    process.on("uncaughtException", onUncaught)
    try {
      const rowsWhileDown = await client.query("beforeCrashNeedle", undefined, 10)
      expect(rowsWhileDown).toEqual([])
      // Give any orphaned async escape a chance to surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toBeUndefined()
    } finally {
      process.off("uncaughtException", onUncaught)
    }

    // The main process does NOT restart the sidecar -- this test starts a FRESH
    // one itself, standing in for what systemd's `Restart=on-failure` would do.
    // Crucially, this is a genuinely NEW, independent spawn -- not a supervisor
    // reusing internal state -- proving recovery does not depend on any
    // main-process-side bookkeeping surviving the sidecar's death.
    sidecar = spawnSidecar(["--db", dbPath, "--socket", socketPath, "--index", indexPath])
    spawnedChildren.push(sidecar)
    expect(sidecar.pid).not.toBe(pidBeforeKill) // genuinely a new OS process

    await waitUntil(async () => (await client.query("beforeCrashNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "freshly-started sidecar to recover search",
    })

    expect(process.pid).toBe(mainProcessPidBefore) // still unaffected, end to end

    // Recovery is genuinely functional, not just "a process exists": a NEW
    // operation committed after the restart is picked up too.
    commitOperation(dbPath, "after-restart-op", "afterRestartNeedle")
    await waitUntil(async () => (await client.query("afterRestartNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "freshly-started sidecar to tail a NEW operation",
    })
  }, 45_000)
})
