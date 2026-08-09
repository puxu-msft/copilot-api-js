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
      expect(runtime.snapshot().restartsTotal).toBe(1)
      expect(runtime.snapshot().replaysTotal).toBe(1)
      expect(outcome).toBe("persisted")

      const read = readonlyHandle(temp.dbPath)
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", `op-${window}`)).toBe(1)
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations")).toBe(1)
      // Journal rows are consumed by recovery or deleted on commit; a leftover row means the
      // operation would be re-applied on every future startup.
      expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
    })
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
    const committed = (read.prepare("SELECT operation_id FROM v3_operations ORDER BY committed_at, operation_id").all() as Array<{ operation_id: string }>).map(
      (row) => row.operation_id,
    )
    expect(committed).toEqual(["op-order-1", "op-order-2", "op-order-3"])
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  })
})

/** Transport whose messages the test writes by hand, to forge generation-mismatched traffic. */
describe("History Worker generation isolation", () => {
  test("an ACK from a retired generation is ignored, counted, and does not settle the envelope", async () => {
    const transports: Array<ScriptedTransport> = []
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerFactory: (generation) => {
        const transport = new ScriptedTransport(generation)
        transports.push(transport)
        return transport
      },
    })
    // Deliberately not registered for the shared shutdown: this transport answers nothing it
    // is not told to, and it owns no thread, file or socket to release.

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
})
