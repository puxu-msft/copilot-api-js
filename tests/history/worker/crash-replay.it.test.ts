import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import path from "node:path"

import type { Database } from "~/lib/history/sqlite/connection"
import type { HistoryPersistenceOutcome } from "~/lib/history/worker/protocol"

import { openDatabaseReadonly } from "~/lib/history/sqlite/connection"
import { HistoryPersistenceRuntimeImpl } from "~/lib/history/worker/runtime"

import type { TempSemanticDb } from "./fixtures/semantic-envelope"

import { ScriptedTransport } from "./fixtures/scripted-transport"
import {
  //
  buildEnvelope,
  buildStartConfig,
  buildTerminalRecord,
  createTempSemanticDb,
} from "./fixtures/semantic-envelope"

const crashWorkerUrl = new URL("./fixtures/crash-window-worker.ts", import.meta.url)

const openTempDbs: Array<TempSemanticDb> = []
const openRuntimes: Array<HistoryPersistenceRuntimeImpl> = []
const openReadHandles: Array<Database> = []

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) await runtime.shutdown()
  for (const handle of openReadHandles.splice(0)) handle.close()
  for (const temp of openTempDbs.splice(0)) temp.cleanup()
})

function readonlyHandle(dbPath: string): Database {
  const handle = openDatabaseReadonly(dbPath)
  openReadHandles.push(handle)
  return handle
}

function count(db: Database, sql: string, ...params: Array<unknown>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n
}

/** Restart delay is collapsed to 1 ms: this suite asserts convergence, not the backoff curve. */
function crashingRuntime(window: string, markerPath: string): HistoryPersistenceRuntimeImpl {
  const runtime = new HistoryPersistenceRuntimeImpl({
    workerUrl: crashWorkerUrl,
    workerData: { window, markerPath },
    restart: { initialDelayMs: 1, maxDelayMs: 1 },
  })
  openRuntimes.push(runtime)
  return runtime
}

function tempDb(prefix: string): TempSemanticDb {
  const temp = createTempSemanticDb(prefix)
  openTempDbs.push(temp)
  return temp
}

const CRASH_WINDOWS = [
  //
  "before-journal",
  "after-journal",
  "mid-transaction",
  "after-commit",
] as const

/**
 * Persisted state each window must observe at the instant it crashes, measured (not reasoned)
 * through the Worker's own connection — so `mid-transaction` sees its own uncommitted row,
 * which is what distinguishes it from `after-journal`.
 */
const EXPECTED_CRASH_STATE: Record<(typeof CRASH_WINDOWS)[number], { journal: number; operations: number }> = {
  "before-journal": { journal: 0, operations: 0 },
  "after-journal": { journal: 1, operations: 0 },
  "mid-transaction": { journal: 1, operations: 1 },
  "after-commit": { journal: 0, operations: 1 },
}

describe("History Worker crash windows", () => {
  for (const window of CRASH_WINDOWS) {
    test(`converges to exactly one operation after a crash ${window}`, async () => {
      const temp = tempDb(`history-worker-2a-${window}-`)
      const markerPath = path.join(temp.dir, "crashed.marker")
      const runtime = crashingRuntime(window, markerPath)
      await runtime.start(buildStartConfig(temp.dbPath))

      const outcome = await new Promise<HistoryPersistenceOutcome>((resolve) => runtime.enqueue(buildEnvelope(buildTerminalRecord(`op-${window}`)), resolve))

      // The crash must actually have happened, or this asserts nothing about recovery.
      expect(fs.existsSync(markerPath)).toBe(true)
      // ...and it must have happened at the moment this window is NAMED for. The marker
      // carries the persisted state read at the crash instant through the Worker's own
      // connection, so an injection point that drifts elsewhere cannot stay green.
      expect(JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown).toEqual({ window, ...EXPECTED_CRASH_STATE[window] })
      expect(runtime.snapshot().restartsTotal).toBe(1)
      expect(runtime.snapshot().replaysTotal).toBe(1)
      expect(outcome).toBe("persisted")

      const read = readonlyHandle(temp.dbPath)
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", `op-${window}`)).toBe(1)
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations")).toBe(1)
      // Journal rows are consumed by recovery or deleted on commit; a leftover row means the
      // operation would be re-applied on every future startup.
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
    }, 20_000)
  }

  test("replays every queued envelope in submission order after a crash", async () => {
    const temp = tempDb("history-worker-2a-order-")
    const markerPath = path.join(temp.dir, "crashed.marker")
    const runtime = crashingRuntime("mid-transaction", markerPath)
    await runtime.start(buildStartConfig(temp.dbPath))

    const outcomes = await Promise.all(
      ["op-order-1", "op-order-2", "op-order-3"].map(
        async (operationId) =>
          await new Promise<HistoryPersistenceOutcome>((resolve) => runtime.enqueue(buildEnvelope(buildTerminalRecord(operationId)), resolve)),
      ),
    )

    expect(outcomes).toEqual(["persisted", "persisted", "persisted"])
    expect(runtime.snapshot().restartsTotal).toBe(1)
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)

    const read = readonlyHandle(temp.dbPath)
    // `rowid` is insertion order. Ordering by `committed_at` would fall back to the
    // `operation_id` tie-break whenever the three commits land in the same millisecond,
    // which makes the expected sequence come out right no matter what order replay used.
    const committed = (read.prepare("SELECT operation_id FROM v3_operations ORDER BY rowid").all() as Array<{ operation_id: string }>).map(
      (row) => row.operation_id,
    )
    expect(committed).toEqual(["op-order-1", "op-order-2", "op-order-3"])
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  }, 20_000)
})

/** Transport whose messages the test writes by hand, to forge generation-mismatched traffic. */
describe("History Worker generation isolation", () => {
  /** Start a runtime on scripted transports whose restarts fire synchronously. */
  function scriptedRuntime(): { runtime: HistoryPersistenceRuntimeImpl; transports: Array<ScriptedTransport> } {
    const transports: Array<ScriptedTransport> = []
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerFactory: (generation) => {
        const transport = new ScriptedTransport(generation)
        transports.push(transport)
        return transport
      },
      restart: { setTimer: (fn) => (fn(), () => {}) },
    })
    // Deliberately not registered for the shared shutdown: these transports answer nothing they
    // are not told to, and own no thread, file or socket to release.
    return { runtime, transports }
  }

  test("an ACK claiming a generation that does not exist yet is ignored, counted, and settles nothing", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    const first = transports[0]
    expect(first).toBeDefined()
    first?.emitReady()
    await started

    let settled: HistoryPersistenceOutcome | undefined
    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-stale-1")), (outcome) => {
      settled = outcome
    })

    // Generation 2 does not exist yet: an ACK claiming it may not settle anything.
    first?.emitPersistResult(messageId, "persisted", 2)
    expect(settled).toBeUndefined()
    expect(runtime.snapshot().staleMessagesTotal).toBe(1)
    expect(runtime.snapshot().pendingEnvelopes).toBe(1)
    expect(runtime.snapshot().terminalFailed).toBe(false)

    first?.emitPersistResult(messageId, "persisted")
    expect(settled).toBe("persisted")
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
  })

  test("a late ACK from a RETIRED generation is ignored after the replacement takes over", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    let settled: HistoryPersistenceOutcome | undefined
    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-retired-1")), (outcome) => {
      settled = outcome
    })

    // Generation 1 dies; the synchronous restart timer brings generation 2 up immediately.
    transports[0]?.emitExit(1)
    transports[1]?.emitReady()
    expect(transports).toHaveLength(2)

    // This is the direction spec §7.1 actually cares about: the dead generation's in-flight
    // ACK arrives after its replacement is serving. Believing it would settle an envelope
    // whose write may have died with the thread that claimed it.
    transports[0]?.emitPersistResult(messageId, "persisted", 1)
    expect(settled).toBeUndefined()
    expect(runtime.snapshot().pendingEnvelopes).toBe(1)
    expect(runtime.snapshot().staleMessagesTotal).toBe(1)
    expect(runtime.snapshot().terminalFailed).toBe(false)

    // Only the current generation's ACK settles it.
    transports[1]?.emitPersistResult(messageId, "persisted", 2)
    expect(settled).toBe("persisted")
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
  })

  test("counts only envelopes a previous generation saw as replays", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    // Handed to generation 1, so its re-delivery IS a replay.
    const replayed = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-replay-seen")), () => {})
    transports[0]?.emitExit(1)

    // Queued while no generation is ready, so it is being SENT for the first time. Counting
    // it would inflate the metric operators use to spot a crash-looping Worker.
    const fresh = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-replay-new")), () => {})
    expect(runtime.snapshot().replaysTotal).toBe(0)

    transports[1]?.emitReady()
    expect(runtime.snapshot().replaysTotal).toBe(1)
    expect(runtime.snapshot().pendingEnvelopes).toBe(2)

    transports[1]?.emitPersistResult(replayed, "persisted", 2)
    transports[1]?.emitPersistResult(fresh, "persisted", 2)
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
  })

  test("one crash producing both error and exit restarts exactly once", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    // A real `node:worker_threads` Worker emits BOTH on an uncaught exception. Without
    // deduplication each event schedules its own restart, so two live generations end up
    // running and one becomes an orphan writer nobody holds a reference to.
    transports[0]?.emitError(new Error("uncaught in worker"))
    transports[0]?.emitExit(1)

    expect(transports).toHaveLength(2)
    expect(runtime.snapshot().restartsTotal).toBe(1)
    expect(runtime.snapshot().consecutiveFailures).toBe(1)
  })

  test("waits the restart delay the policy computed, rather than restarting immediately", async () => {
    const scheduled: Array<number> = []
    const transports: Array<ScriptedTransport> = []
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerFactory: (generation) => {
        const transport = new ScriptedTransport(generation)
        transports.push(transport)
        return transport
      },
      restart: {
        initialDelayMs: 40,
        maxDelayMs: 30_000,
        setTimer: (fn, ms) => {
          scheduled.push(ms)
          fn()
          return () => {}
        },
      },
    })

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    // Two crashes without an intervening ready: the delay must grow, which is the only
    // observable difference between a wired-up backoff and a hard-coded 0.
    transports[0]?.emitExit(1)
    transports[1]?.emitExit(1)

    expect(scheduled).toEqual([40, 80])
  })

  test("a NEW generation ACKing a message an older one already settled is a protocol violation", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-crossgen-1")), () => {})
    transports[0]?.emitPersistResult(messageId, "persisted")
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)

    transports[0]?.emitExit(1)
    transports[1]?.emitReady()

    // Generation 2 never received this message: a replayed envelope is only re-sent while
    // still unacked, and this one was settled before the crash. Without the generation on
    // the tombstone this reads as a benign duplicate and a Worker inventing message IDs
    // runs on undetected.
    transports[1]?.emitPersistResult(messageId, "persisted", 2)

    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toMatch(/generation 2 ACKed message .*which generation 1 had already settled/)
    expect(runtime.snapshot().duplicateAcksTotal).toBe(0)
  })

  test("a duplicate ACK is tolerated once, and a changed outcome is terminal", async () => {
    const { runtime, transports } = scriptedRuntime()

    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started

    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-tombstone-1")), () => {})
    transports[0]?.emitPersistResult(messageId, "persisted")
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)

    // The tombstone makes a repeat of the SAME outcome idempotent — an at-least-once
    // transport may deliver it twice — while still being able to catch a contradiction.
    transports[0]?.emitPersistResult(messageId, "persisted")
    expect(runtime.snapshot().duplicateAcksTotal).toBe(1)
    expect(runtime.snapshot().terminalFailed).toBe(false)

    transports[0]?.emitPersistResult(messageId, "failed")
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toMatch(/changed outcome from persisted to failed/)
  })
})
