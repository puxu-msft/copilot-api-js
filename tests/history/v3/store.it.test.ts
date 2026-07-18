import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  drainV3Writer,
  enqueueModelOperation,
  getV3Operation,
  getV3StoredOperation,
  getV3StoreStatus,
  ensureV3Schema,
  listV3Operations,
  prepareModelOperation,
  recoverV3Journal,
  resetV3WriterForTests,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"

function terminalRecord(id: string, shared = "same prompt") {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload({ prompt: shared }, { origin: { stage: "ingress", track: "client" } })
  const frame = recorder.registerFrame({ event: "message", data: `hello-${id}` }, { origin: { stage: "upstream", track: "upstream" } })
  recorder.recordIngress({ request: { payload: request } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { frames: [frame] } })
  recorder.recordEgress({ upstream: { frames: [frame] }, client: { frames: [frame] } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt, extensions: { "future.field": { kept: true } } })
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
})

afterEach(async () => {
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 semantic store", () => {
  test("accepts JSON-compatible shared references instead of misclassifying them as cycles", () => {
    const shared = { type: "text", text: "same block" }
    const recorder = createModelOperationRecorder({ identity: { operationId: "shared-dag", kind: "generation", createdAt: 100 } })
    const payload = recorder.registerPayload({ content: [shared], mirrored: shared }, { origin: { stage: "ingress", track: "client" } })
    recorder.recordIngress({ request: { payload } })
    const operation = recorder.commitTerminal({ outcome: "completed" })

    const prepared = prepareModelOperation(operation)
    commitPreparedOperation(getDatabase(), prepared)
    expect(getV3Operation("shared-dag")?.arena.payloads[0]?.value).toEqual({
      content: [{ type: "text", text: "same block" }],
      mirrored: { type: "text", text: "same block" },
    })
  })

  test("migrates legacy operation rows to an explicitly marked storage-commit upper bound", () => {
    closeDatabase()
    openInMemoryDatabase()
    const db = getDatabase()
    db.exec(`
      CREATE TABLE v3_operations (
        operation_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        terminal_sequence INTEGER NOT NULL,
        manifest_gz BLOB NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        committed_at INTEGER NOT NULL
      );
    `)
    db.prepare("INSERT INTO v3_operations VALUES(?,?,?,?,?,?,?,?,?)").run("legacy", 1, "digest", "generation", 1_000, 4, new Uint8Array([1]), 0, 9_000)

    ensureV3Schema(db)
    ensureV3Schema(db)

    expect(db.prepare("SELECT ended_at,timing_source FROM v3_operations WHERE operation_id='legacy'").get()).toEqual({
      ended_at: 9_000,
      timing_source: "storage-commit-upper-bound",
    })
    db.prepare("UPDATE v3_operations SET ended_at=NULL WHERE operation_id='legacy'").run()
    ensureV3Schema(db)
    expect(db.prepare("SELECT ended_at FROM v3_operations WHERE operation_id='legacy'").get()).toEqual({ ended_at: null })
  })

  test("keeps newly imported records without canonical terminal time explicitly unavailable", () => {
    const current = terminalRecord("legacy-terminal-time")
    // Intentionally model an already-persisted JSON record from before canonical event clocks.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const legacy = JSON.parse(JSON.stringify(current)) as typeof current
    if (legacy.terminal) delete (legacy.terminal as { occurredAt?: number }).occurredAt
    const prepared = prepareModelOperation(legacy)
    commitPreparedOperation(getDatabase(), prepared)

    const stored = getV3StoredOperation("legacy-terminal-time")!
    expect(stored.timingSource).toBe("unavailable")
    expect(stored.endedAt).toBeUndefined()
  })

  test("round-trips the canonical record and keeps unknown extensions", async () => {
    const record = terminalRecord("op-roundtrip")
    await enqueueModelOperation(record)
    await drainV3Writer()

    // Persistence-neutral JSON wire oracle: stored records are JSON semantic documents.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(getV3Operation(record.identity.operationId)).toEqual(JSON.parse(JSON.stringify(record)))
    expect(listV3Operations("generation").map((item) => item.identity.operationId)).toEqual(["op-roundtrip"])
    expect(getV3StoreStatus()).toMatchObject({ persistedOperations: 1, failedOperations: 0, pendingOperations: 0 })
  })

  test("deduplicates canonical semantic objects across operations", async () => {
    await enqueueModelOperation(terminalRecord("op-a"))
    await enqueueModelOperation(terminalRecord("op-b"))
    await drainV3Writer()

    const objectCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_objects").get() as { n: number }).n
    expect(objectCount).toBe(3) // one shared request + two distinct frames
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM v3_operations").get() as { n: number }).n).toBe(2)
  })

  test("is idempotent for the same revision and rejects a conflicting digest", () => {
    const original = prepareModelOperation(terminalRecord("op-idempotent"))
    expect(commitPreparedOperation(getDatabase(), original)).toBe("inserted")
    expect(commitPreparedOperation(getDatabase(), original)).toBe("idempotent")

    const conflicting = { ...original, digest: "different" }
    expect(() => commitPreparedOperation(getDatabase(), conflicting)).toThrow(/operation conflict/i)
  })

  test("recovers a self-contained uncommitted journal after the operation transaction fails", () => {
    const prepared = prepareModelOperation(terminalRecord("op-failpoint"))
    getDatabase().exec(V3_SCHEMA_SQL)
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'failpoint'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/failpoint/i)
    const row = getDatabase().prepare("SELECT committed_at FROM v3_journal WHERE operation_id=?").get(prepared.id) as { committed_at: number | null }
    expect(row.committed_at).toBeNull()

    getDatabase().exec("DROP TRIGGER fail_v3_operation")
    expect(recoverV3Journal()).toBe(1)
    expect(getV3Operation(prepared.id)?.identity.operationId).toBe(prepared.id)
    expect(getDatabase().prepare("SELECT 1 FROM v3_journal WHERE operation_id=?").get(prepared.id)).toBeNull()
  })
})
