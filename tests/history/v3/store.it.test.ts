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
  getV3StoreStatus,
  listV3Operations,
  prepareModelOperation,
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
  test("round-trips the canonical record and keeps unknown extensions", async () => {
    const record = terminalRecord("op-roundtrip")
    await enqueueModelOperation(record)
    await drainV3Writer()

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

  test("keeps an uncommitted journal row when the transaction fails", () => {
    const prepared = prepareModelOperation(terminalRecord("op-failpoint"))
    getDatabase().exec(V3_SCHEMA_SQL)
    getDatabase().exec(`CREATE TRIGGER fail_v3_operation BEFORE INSERT ON v3_operations BEGIN SELECT RAISE(ABORT, 'failpoint'); END;`)

    expect(() => commitPreparedOperation(getDatabase(), prepared)).toThrow(/failpoint/i)
    const row = getDatabase().prepare("SELECT committed_at FROM v3_journal WHERE operation_id=?").get(prepared.id) as { committed_at: number | null }
    expect(row.committed_at).toBeNull()
  })
})
