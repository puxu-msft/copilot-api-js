/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 3 — main-process supervisor. Spawns a REAL child OS process
 * (`bun run src/main.ts history-search-daemon ...`, no mocking of node:child_process),
 * and proves the plan's central crash-isolation claim: a `kill -9` on the sidecar
 * child leaves the MAIN test process (this Bun worker) completely unaffected —
 * still running, PID unchanged, UDS client degrades to empty results instead of
 * throwing, and the supervisor autonomously restarts the sidecar and search
 * recovers once it comes back up.
 *
 * These tests spawn real subprocesses and take real wall-clock seconds (backoff
 * delays, sidecar startup) — deliberately `.it`, not `.unit`.
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

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  createHistorySearchSupervisor,
  resolveEntryPath,
} from "~/lib/history/search/supervisor"
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
// interaction is polling `supervisor.client.query()` BEFORE the sidecar's
// socket necessarily exists yet — exactly the `bun test`-only scenario that
// needs priming (confirmed empirically not to be a production bug).
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

const runningSupervisors: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => {
  for (const supervisor of runningSupervisors.splice(0)) await supervisor.stop()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("resolveEntryPath", () => {
  test("resolves to an existing script on disk in this dev checkout", () => {
    const entryPath = resolveEntryPath()
    expect(fs.existsSync(entryPath)).toBe(true)
    expect(entryPath.endsWith("main.ts") || entryPath.endsWith("main.mjs")).toBe(true)
  })
})

describe("supervisor: end-to-end spawn + tail + UDS (real child process, no mocking)", () => {
  test("spawns the sidecar, tails a committed operation, and the client finds it over UDS", async () => {
    const dbDir = freshDir("supervisor-e2e-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("supervisor-e2e-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("supervisor-e2e-index-"), "index")

    commitOperation(dbPath, "e2e-op", "supervisorE2Eneedle")

    const supervisor = createHistorySearchSupervisor({ dbPath, socketPath, indexPath })
    runningSupervisors.push(supervisor)
    supervisor.start()

    // Poll the client (never-throw) until the sidecar has actually tailed + flushed —
    // startup + first tail + first flush is not instantaneous.
    await waitUntil(async () => (await supervisor.client.query("supervisorE2Eneedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "sidecar to tail and index the committed operation",
    })

    const rows = await supervisor.client.query("supervisorE2Eneedle", undefined, 10)
    expect(rows.map((hit) => hit.operationId)).toEqual(["e2e-op"])
    expect(supervisor.getStatus().pid).toBeDefined()
  }, 20_000)
})

describe("crash isolation: kill -9 the sidecar, main process (this test worker) must survive untouched", () => {
  test("SIGKILL the child -> main process PID unchanged, client degrades to empty (never throws), supervisor restarts it, search recovers", async () => {
    const dbDir = freshDir("supervisor-crash-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    const socketPath = path.join(freshDir("supervisor-crash-sock-"), "history-search.sock")
    const indexPath = path.join(freshDir("supervisor-crash-index-"), "index")

    commitOperation(dbPath, "before-crash-op", "beforeCrashNeedle")

    const mainProcessPidBefore = process.pid

    const supervisor = createHistorySearchSupervisor({ dbPath, socketPath, indexPath })
    runningSupervisors.push(supervisor)
    supervisor.start()

    await waitUntil(async () => (await supervisor.client.query("beforeCrashNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "sidecar to index the pre-crash operation",
    })

    const pidBeforeKill = supervisor.getStatus().pid
    expect(pidBeforeKill).toBeDefined()

    // The actual crash-isolation act: kill -9 the CHILD (never this test's own process).
    process.kill(pidBeforeKill!, "SIGKILL")

    // The core assertion this whole plan exists for: THIS process is completely
    // unaffected by the sidecar's death — no uncaughtException, no exit, same PID.
    expect(process.pid).toBe(mainProcessPidBefore)

    // The client must degrade to empty (never throw/reject) while the sidecar is down.
    await waitUntil(
      async () => {
        const rows = await supervisor.client.query("beforeCrashNeedle", undefined, 10)
        return rows.length === 0 // socket gone (or connecting to a stale/dead one) -> empty, not a throw
      },
      { timeout: 5_000, interval: 100, label: "client to observe the dead sidecar as empty results" },
    )
    // The above resolving at all (never throwing) is itself part of the assertion;
    // a throw would have failed the test via an unhandled rejection.

    // Supervisor must autonomously restart the sidecar (capped backoff, well under
    // MAX_CONSECUTIVE_RAPID_EXITS since this was a single kill, not a crash loop).
    await waitUntil(async () => (await supervisor.client.query("beforeCrashNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "supervisor to restart the sidecar and search to recover",
    })

    const pidAfterRestart = supervisor.getStatus().pid
    expect(pidAfterRestart).toBeDefined()
    expect(pidAfterRestart).not.toBe(pidBeforeKill) // genuinely a NEW OS process, not the same one surviving

    expect(process.pid).toBe(mainProcessPidBefore) // still unaffected, end to end

    // Recovery is genuinely functional, not just "a process exists": a NEW
    // operation committed after the restart is picked up too.
    commitOperation(dbPath, "after-restart-op", "afterRestartNeedle")
    await waitUntil(async () => (await supervisor.client.query("afterRestartNeedle", undefined, 10)).length > 0, {
      timeout: 15_000,
      interval: 200,
      label: "restarted sidecar to tail a NEW operation",
    })
  }, 60_000)
})

describe("crash-loop protection: a sidecar that fails immediately, repeatedly, must NOT restart forever", () => {
  test("a sidecar that exits immediately every time hits MAX_CONSECUTIVE_RAPID_EXITS and reports abandoned", async () => {
    // Point the sidecar at a db path whose PARENT DIRECTORY DOES NOT EXIST — the
    // daemon's own readonly-open path will refuse to create it (openDatabaseReadonly
    // is read-only by design), but far more reliably: point `--index` somewhere the
    // native module cannot write, forcing a real, deterministic, immediate crash of
    // the daemon's `run()` before it ever finishes constructing (an unhandled
    // rejection inside `run` makes the whole citty command reject -> the child
    // process exits non-zero almost instantly, every single restart).
    const dbDir = freshDir("supervisor-crashloop-db-")
    const dbPath = path.join(dbDir, "history-v3.db")
    commitOperation(dbPath, "seed-op", "seedneedle")
    const socketPath = path.join(freshDir("supervisor-crashloop-sock-"), "history-search.sock")
    // A path that exists as a FILE (not a directory) — the native HistoryIndex
    // constructor's `fs::create_dir_all` on it must fail deterministically and
    // immediately on every single attempt.
    const indexParent = freshDir("supervisor-crashloop-index-")
    const indexPath = path.join(indexParent, "not-a-directory")
    fs.writeFileSync(indexPath, "this is a file, not a directory — HistoryIndex::new must fail against it every time")

    const supervisor = createHistorySearchSupervisor({ dbPath, socketPath, indexPath })
    runningSupervisors.push(supervisor)
    supervisor.start()

    await waitUntil(() => supervisor.getStatus().abandoned, {
      timeout: 30_000,
      interval: 200,
      label: "supervisor to give up after MAX_CONSECUTIVE_RAPID_EXITS rapid failures",
    })

    const status = supervisor.getStatus()
    expect(status.abandoned).toBe(true)
    expect(status.consecutiveRapidExits).toBeGreaterThanOrEqual(5)

    // Once abandoned, the supervisor must NOT keep spawning — wait a bit longer and
    // confirm the rapid-exit count does not keep climbing indefinitely.
    const countAtAbandon = status.consecutiveRapidExits
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(supervisor.getStatus().consecutiveRapidExits).toBe(countAtAbandon)

    // The client must still degrade to empty, never throw, while abandoned.
    expect(await supervisor.client.query("seedneedle", undefined, 10)).toEqual([])
  }, 45_000)
})
