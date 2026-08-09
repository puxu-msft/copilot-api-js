import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Database } from "~/lib/history/sqlite/connection"

import { openDatabaseReadonly } from "~/lib/history/sqlite/connection"
import { HistoryPersistenceRuntimeImpl } from "~/lib/history/worker/runtime"

import type { TempSemanticDb } from "./fixtures/semantic-envelope"

import {
  //
  EXPECTED_TRACK_NAMES,
  buildEnvelope,
  buildStartConfig,
  buildTerminalRecord,
  createTempSemanticDb,
} from "./fixtures/semantic-envelope"

const workerUrl = new URL("../../../src/lib/history/worker/history-worker.ts", import.meta.url)
const retryObserverWorkerUrl = new URL("./fixtures/retry-observer-worker.ts", import.meta.url)

const openTempDbs: Array<TempSemanticDb> = []
const openRuntimes: Array<HistoryPersistenceRuntimeImpl> = []
const openReadHandles: Array<Database> = []

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) await runtime.shutdown()
  for (const handle of openReadHandles.splice(0)) handle.close()
  for (const temp of openTempDbs.splice(0)) temp.cleanup()
})

function tempDb(prefix?: string): TempSemanticDb {
  const temp = createTempSemanticDb(prefix)
  openTempDbs.push(temp)
  return temp
}

function runtimeFor(url: URL, workerData?: unknown): HistoryPersistenceRuntimeImpl {
  const runtime = new HistoryPersistenceRuntimeImpl({ workerUrl: url, workerData })
  openRuntimes.push(runtime)
  return runtime
}

/** Independent readonly connection: the persistence claim is adjudicated by a handle the Worker never touched. */
function readonlyHandle(dbPath: string): Database {
  const handle = openDatabaseReadonly(dbPath)
  openReadHandles.push(handle)
  return handle
}

function count(db: Database, sql: string, ...params: Array<unknown>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n
}

describe("semantic Worker backend", () => {
  test("persists a terminal operation to a real on-disk database", async () => {
    const temp = tempDb()
    const runtime = runtimeFor(workerUrl)
    await runtime.start(buildStartConfig(temp.dbPath))

    const record = buildTerminalRecord("op-disk-1")
    const outcome = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(record), resolve))
    expect(outcome).toBe("persisted")

    const read = readonlyHandle(temp.dbPath)
    const operation = read.prepare("SELECT operation_id,kind,revision,digest,summary_json,terminal_sequence FROM v3_operations").get() as {
      operation_id: string
      kind: string
      revision: number
      digest: string
      summary_json: string | null
      terminal_sequence: number
    }
    expect(operation.operation_id).toBe("op-disk-1")
    expect(operation.kind).toBe("generation")
    expect(operation.revision).toBe(record.lastSequence)
    expect(operation.terminal_sequence).toBe(record.terminal?.sequence ?? -1)
    expect(operation.digest).toMatch(/^[0-9a-f]{64}$/)

    const summary = JSON.parse(operation.summary_json ?? "null") as { id?: string; state?: string } | null
    expect(summary?.id).toBe("op-disk-1")
    expect(summary?.state).toBe("completed")

    const trackNames = (
      read.prepare("SELECT track_name FROM v3_tracks WHERE operation_id=? ORDER BY rowid").all("op-disk-1") as Array<{ track_name: string }>
    ).map((row) => row.track_name)
    expect(trackNames).toEqual([...EXPECTED_TRACK_NAMES])

    expect(count(read, "SELECT COUNT(*) AS n FROM v3_timeline_chunks WHERE operation_id=?", "op-disk-1")).toBeGreaterThan(0)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_objects")).toBeGreaterThan(0)
    // The journal is a crash-recovery ledger, not an archive: a committed operation leaves it empty.
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  })

  test("re-persisting the same terminal record is idempotent and leaves exactly one row", async () => {
    const temp = tempDb()
    const runtime = runtimeFor(workerUrl)
    await runtime.start(buildStartConfig(temp.dbPath))

    const record = buildTerminalRecord("op-idempotent-1")
    const first = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(record), resolve))
    const second = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(record), resolve))
    expect([first, second]).toEqual(["persisted", "persisted"])

    const read = readonlyHandle(temp.dbPath)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", "op-idempotent-1")).toBe(1)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  })

  test("the real backend caps every retry wait at the configured maxBackoffMs", async () => {
    const temp = tempDb("history-worker-2a-retry-")
    const observedDelaysPath = `${temp.dir}/observed-delays.json`
    const runtime = runtimeFor(retryObserverWorkerUrl, { observedDelaysPath, transientFailures: 5 })
    // Non-default cap: DEFAULT_V3_PERSIST_RETRY_CONFIG uses 5000, so 137 can only come from this config.
    await runtime.start(buildStartConfig(temp.dbPath, { persistRetry: { maxAttempts: 6, backoffMs: 100, maxBackoffMs: 137, maxTotalMs: 0 } }))

    const outcome = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(buildTerminalRecord("op-retry-1")), resolve))
    expect(outcome).toBe("persisted")

    const observed = JSON.parse(await Bun.file(observedDelaysPath).text()) as Array<number>
    // Uncapped exponential backoff would be [100, 200, 400, 800, 1600].
    expect(observed).toEqual([100, 137, 137, 137, 137])

    const read = readonlyHandle(temp.dbPath)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", "op-retry-1")).toBe(1)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  })

  test("initialize rejects a persistRetry budget missing maxBackoffMs at the protocol boundary", async () => {
    const temp = tempDb()
    const runtime = runtimeFor(workerUrl)
    const config = buildStartConfig(temp.dbPath)
    const withoutCap = { ...config, persistRetry: { maxAttempts: 1, backoffMs: 0, maxTotalMs: 0 } as unknown as typeof config.persistRetry }

    await expect(runtime.start(withoutCap)).rejects.toThrow(/persistRetry\.maxBackoffMs/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
  })

  test("initialize rejects a negative maxBackoffMs at the protocol boundary", async () => {
    const temp = tempDb()
    const runtime = runtimeFor(workerUrl)
    const config = buildStartConfig(temp.dbPath, { persistRetry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: -1, maxTotalMs: 0 } })

    await expect(runtime.start(config)).rejects.toThrow(/persistRetry\.maxBackoffMs/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
  })

  test("a startup owner-check failure reports fatal instead of silently degrading", async () => {
    const temp = tempDb("history-worker-2a-unowned-")
    await Bun.write(temp.dbPath, "")
    const unowned = openDatabaseReadonlySafe(temp.dbPath)
    expect(unowned).toBeUndefined()

    const runtime = runtimeFor(workerUrl)
    await expect(runtime.start(buildStartConfig(temp.dbPath))).rejects.toThrow(/refusing to open unowned/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().ready).toBe(false)
  })
})

/** Confirms the artifact really is unowned before asserting the Worker refuses it. */
function openDatabaseReadonlySafe(dbPath: string): Database | undefined {
  try {
    const handle = openDatabaseReadonly(dbPath)
    openReadHandles.push(handle)
    return handle
  } catch {
    return undefined
  }
}
