import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  openDatabaseReadonly,
  openOwnedHistoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  ensureV3Schema,
  prepareModelOperation,
} from "~/lib/history/v3/store"
import { HISTORY_WORKER_RETRYABLE_STARTUP_EXIT } from "~/lib/history/worker/protocol"
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
const permanentFailureWorkerUrl = new URL("./fixtures/permanent-failure-worker.ts", import.meta.url)
const retryableStartupWorkerUrl = new URL("./fixtures/retryable-startup-worker.ts", import.meta.url)

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

  test("a permanent write failure reports failed and leaves no operation row", async () => {
    const temp = tempDb("history-worker-2a-permanent-")
    const runtime = runtimeFor(permanentFailureWorkerUrl)
    await runtime.start(buildStartConfig(temp.dbPath))

    const outcome = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(buildTerminalRecord("op-failed-1")), resolve))
    // `failed` is what spec §8.2 step 6 escalates into a failed shutdown. A backend that
    // reported `persisted` here would release the reservation and exit 0 having lost the record.
    expect(outcome).toBe("failed")

    const read = readonlyHandle(temp.dbPath)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", "op-failed-1")).toBe(0)
    // The journal row survives precisely so a later recovery pass can replay it.
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal WHERE operation_id=?", "op-failed-1")).toBe(1)
  })

  test("a same-id record with a different digest reports conflict and does not overwrite the stored row", async () => {
    const temp = tempDb("history-worker-2a-conflict-")
    const runtime = runtimeFor(workerUrl)
    await runtime.start(buildStartConfig(temp.dbPath))

    const firstRecord = buildTerminalRecord("op-conflict-1", { text: "first" })
    const secondRecord = buildTerminalRecord("op-conflict-1", { text: "second" })
    const firstDigest = prepareModelOperation(firstRecord).digest
    const secondDigest = prepareModelOperation(secondRecord).digest
    // Guard the guard: if the two records hashed the same, the Worker would legitimately
    // report `idempotent` and this test would prove nothing about conflicts.
    expect(firstDigest).not.toBe(secondDigest)

    const first = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(firstRecord), resolve))
    const second = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(secondRecord), resolve))
    // A data-contract violation, never a persistence failure: it must be distinguishable
    // from both `persisted` (which would claim the second write landed) and `failed`
    // (which would escalate a programming error into a failed shutdown).
    expect([first, second]).toEqual(["persisted", "conflict"])

    const read = readonlyHandle(temp.dbPath)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", "op-conflict-1")).toBe(1)
    const stored = read.prepare("SELECT digest FROM v3_operations WHERE operation_id=?").get("op-conflict-1") as { digest: string }
    // The FIRST record still owns the row — a conflict must not overwrite what was stored.
    expect(stored.digest).toBe(firstDigest)
  })

  test("startup recovery replays an orphan journal row with no envelope in flight", async () => {
    const temp = tempDb("history-worker-2a-orphan-")
    // Seeded from the main thread so the assertion is about RECOVERY only: no envelope is
    // ever enqueued, so the runtime's crash-replay path cannot satisfy it. Without this
    // separation, replay and recovery each hide the other's absence.
    seedOrphanJournalRow(temp.dbPath, buildTerminalRecord("op-orphan-1"))

    const before = readonlyHandle(temp.dbPath)
    expect(count(before, "SELECT COUNT(*) AS n FROM v3_journal WHERE committed_at IS NULL")).toBe(1)
    expect(count(before, "SELECT COUNT(*) AS n FROM v3_operations")).toBe(0)

    const runtime = runtimeFor(workerUrl)
    const ready = await runtime.start(buildStartConfig(temp.dbPath))
    expect(ready.recoveredJournalOperations).toBe(1)
    expect(runtime.snapshot().recoveredJournalOperations).toBe(1)

    const read = readonlyHandle(temp.dbPath)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_operations WHERE operation_id=?", "op-orphan-1")).toBe(1)
    expect(count(read, "SELECT COUNT(*) AS n FROM v3_journal")).toBe(0)
  })

  test("an unrecoverable journal row fails startup instead of becoming ready without it", async () => {
    const temp = tempDb("history-worker-2a-poison-")
    seedPoisonJournalRow(temp.dbPath)

    const runtime = runtimeFor(workerUrl)
    // Spec §8.1: journal recovery is a startup hard gate. Becoming ready here would strand a
    // terminal operation with nothing but an `error` column to show for it.
    await expect(runtime.start(buildStartConfig(temp.dbPath))).rejects.toThrow(/journal recovery left 1 uncommitted row/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().ready).toBe(false)
  })

  test("the retry budget stops on maxTotalMs before exhausting maxAttempts", async () => {
    const temp = tempDb("history-worker-2a-total-")
    const observedDelaysPath = `${temp.dir}/observed-delays.json`
    const runtime = runtimeFor(retryObserverWorkerUrl, { observedDelaysPath, transientFailures: 20, realSleep: true })
    // 8 attempts are permitted, but the 250ms wall-clock budget is consumed first: this is
    // the only assertion that can tell `maxTotalMs` from a field that is never forwarded.
    await runtime.start(buildStartConfig(temp.dbPath, { persistRetry: { maxAttempts: 8, backoffMs: 100, maxBackoffMs: 100, maxTotalMs: 250 } }))

    const outcome = await new Promise<string>((resolve) => runtime.enqueue(buildEnvelope(buildTerminalRecord("op-total-1")), resolve))
    expect(outcome).toBe("failed")

    const observed = JSON.parse(await Bun.file(observedDelaysPath).text()) as Array<number>
    // Without the time cap the loop would wait maxAttempts-1 = 7 times.
    expect(observed.length).toBeLessThan(7)
    expect(observed.length).toBeGreaterThan(0)
    expect(observed).toEqual(observed.map(() => 100))
  }, 20_000)

  test("a transient startup failure restarts and eventually becomes ready, instead of going terminal", async () => {
    const temp = tempDb("history-worker-2a-retrystart-")
    const attemptsPath = `${temp.dir}/startup-attempts.txt`
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerUrl: retryableStartupWorkerUrl,
      workerData: { attemptsPath, failures: 2 },
      restart: { initialDelayMs: 1, maxDelayMs: 5 },
    })
    openRuntimes.push(runtime)

    // Capture the crash message from the restart window: it is the only place the Worker's
    // exit code becomes observable, and "the code is a diagnostic value with a reader" is
    // otherwise an unfalsifiable claim about a constant nothing asserts.
    const errorsDuringRestart: Array<string> = []
    runtime.subscribe((status) => {
      if (status.lastError) errorsDuringRestart.push(status.lastError)
    })

    // Spec §7.1: a startup that failed on a condition which clears on its own is retryable.
    // Reporting `fatal` here would take History down for the life of the process because a
    // peer held the write lock for a moment.
    const ready = await runtime.start(buildStartConfig(temp.dbPath))
    expect(ready.configRevision).toBe(1)
    expect(errorsDuringRestart.some((message) => message.includes(String(HISTORY_WORKER_RETRYABLE_STARTUP_EXIT)))).toBe(true)
    expect(await Bun.file(attemptsPath).text()).toBe("3")
    expect(runtime.snapshot()).toMatchObject({ ready: true, terminalFailed: false, restartsTotal: 2 })
  }, 20_000)

  test("a startup owner-check failure reports fatal instead of silently degrading", async () => {
    const temp = tempDb("history-worker-2a-unowned-")
    await Bun.write(temp.dbPath, "")
    const unowned = openDatabaseReadonlySafe(temp.dbPath)
    expect(unowned).toBeUndefined()

    const runtime = runtimeFor(workerUrl)
    await expect(runtime.start(buildStartConfig(temp.dbPath))).rejects.toThrow(/refusing to open unowned/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().ready).toBe(false)
    // Negative control for the retryable-startup path: a PERMANENT startup error must not
    // buy a single restart. Without this, a classifier that said "retryable" to everything
    // would still look correct from the positive test alone.
    expect(runtime.snapshot().restartsTotal).toBe(0)
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

/**
 * Write a valid, uncommitted journal row and nothing else — the exact state a process leaves
 * behind when it dies between the journal append and the operation transaction's COMMIT.
 */
function seedOrphanJournalRow(dbPath: string, record: ModelOperationRecord): void {
  const db = openOwnedHistoryDatabase(dbPath)
  try {
    ensureV3Schema(db)
    const prepared = prepareModelOperation(record)
    db.prepare(
      "INSERT OR REPLACE INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,committed_at,error) VALUES(?,?,?,?,?,?,NULL,NULL)",
    ).run(prepared.id, prepared.revision, prepared.digest, "terminal", prepared.compressedJournalRecord, Date.now())
  } finally {
    db.close()
  }
}

/** A journal row whose payload can never be decompressed — recovery cannot ever succeed for it. */
function seedPoisonJournalRow(dbPath: string): void {
  const db = openOwnedHistoryDatabase(dbPath)
  try {
    ensureV3Schema(db)
    db.prepare(
      "INSERT OR REPLACE INTO v3_journal(operation_id,revision,digest,phase,payload_gz,created_at,committed_at,error) VALUES(?,?,?,?,?,?,NULL,NULL)",
    ).run("op-poison-1", 1, "0".repeat(64), "terminal", new Uint8Array([1, 2, 3]), Date.now())
  } finally {
    db.close()
  }
}
