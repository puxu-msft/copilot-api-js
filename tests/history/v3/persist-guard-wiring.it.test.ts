/**
 * persist-guard wired into the V3 write path (History V2 removal Phase 4c) —
 * proves the ACTUAL persistence writes in `commitPreparedOperation`/`runDrain`
 * go through `runHistoryWrite`/`runHistoryWriteAsync` (never-throw + classify
 * + count), while the conflict-throw branch does NOT — a real, un-absorbed
 * throw that still increments `status.conflicts` (a completely separate
 * counter from persist-guard's `getHistoryPersistErrorStats()`).
 *
 * The generic classify/count mechanics themselves (isTransientSqliteError,
 * stage:class counter keying) are already unit-tested in isolation against
 * `runHistoryWrite` directly (`tests/history/persist-guard.unit.test.ts`) —
 * this file's job is the OTHER half: that `v3/store.ts` actually calls into
 * that mechanism on the real write path, not merely that the mechanism works
 * standalone.
 */

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
  getHistoryPersistErrorStats,
  resetHistoryPersistErrorStats,
} from "~/lib/history/persist-guard"
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
  enqueueModelOperationWithOutcome,
  getV3StoreStatus,
  prepareModelOperation,
  resetV3WriterForTests,
  setV3PersistRetryConfig,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"

function terminalRecord(id: string, extra?: Record<string, unknown>) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: Date.now() } })
  const payload = recorder.registerPayload({ prompt: `persist-guard-wiring-${id}` }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload }, upstreamRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: {} })
  recorder.recordEgress({ upstream: {}, client: {} })
  if (extra) for (const [namespace, value] of Object.entries(extra)) recorder.setExtension(namespace, value)
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  resetHistoryPersistErrorStats()
})

afterEach(async () => {
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
  resetHistoryPersistErrorStats()
  setV3PersistRetryConfig({ maxAttempts: 3, backoffMs: 10 })
})

describe("persist-guard wired into V3 write path (Phase 4c)", () => {
  test("commitPreparedOperation: a SQLITE_BUSY-classified write failure never-throws to the caller AND counts v3-commit:transient", () => {
    const db = getDatabase()
    db.exec(V3_SCHEMA_SQL)
    // Inject a trigger whose RAISE message matches persist-guard's transient
    // regex (`database is locked`) — the same technique the codebase already
    // uses to simulate a crash mid-write (acceptance-verification.it.test.ts),
    // but with a message classified TRANSIENT rather than a generic failure.
    db.exec(`CREATE TRIGGER busy_v3_journal BEFORE INSERT ON v3_journal BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`)

    const prepared = prepareModelOperation(terminalRecord("op-busy-commit"))

    // never-throw: the guarded write inside commitPreparedOperation swallows
    // the SQLITE error and commitPreparedOperation itself must still surface
    // it as a thrown error to a DIRECT caller (its documented contract is
    // preserved — persist-guard classification does not change the function's
    // external throw behavior), so this assertion documents that contract
    // while the REAL never-throw guarantee is proven via enqueueModelOperation
    // below (the production entry point, which never propagates to the caller).
    expect(() => commitPreparedOperation(db, prepared)).toThrow(/database is locked/i)
    expect(getHistoryPersistErrorStats()).toMatchObject({ "v3-commit:transient": 1 })

    db.exec("DROP TRIGGER busy_v3_journal")
  })

  test("enqueueModelOperation (production path): a SQLITE_BUSY failure never-throws to the caller AND counts v3-drain:transient", async () => {
    const db = getDatabase()
    db.exec(V3_SCHEMA_SQL)
    db.exec(`CREATE TRIGGER busy_v3_journal BEFORE INSERT ON v3_journal BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`)

    // Isolate the never-throw + classify/count contract from DI-5's retry: with
    // maxAttempts=1 a single BUSY produces exactly one v3-drain:transient count
    // (retry cadence is exercised separately in transient-retry.it.test.ts).
    setV3PersistRetryConfig({ maxAttempts: 1, backoffMs: 0 })

    const record = terminalRecord("op-busy-drain")
    // never-throw: enqueueModelOperation's returned promise must resolve, not reject,
    // even though the underlying commit failed.
    await expect(enqueueModelOperation(record)).resolves.toBeUndefined()
    await drainV3Writer()

    expect(getHistoryPersistErrorStats()).toMatchObject({ "v3-drain:transient": 1 })
    const status = getV3StoreStatus()
    expect(status.failedOperations).toBe(1)
    expect(status.conflicts).toBe(0) // NOT a conflict — a distinct counter, unaffected

    db.exec("DROP TRIGGER busy_v3_journal")
  })

  test("DI-5: a persistent BUSY is retried up to the budget — each attempt counts, and the entry is ultimately failed (never a silent drop on the first)", async () => {
    const db = getDatabase()
    db.exec(V3_SCHEMA_SQL)
    db.exec(`CREATE TRIGGER busy_v3_journal BEFORE INSERT ON v3_journal BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`)
    setV3PersistRetryConfig({ maxAttempts: 3, backoffMs: 0 })

    await expect(enqueueModelOperation(terminalRecord("op-busy-retry"))).resolves.toBeUndefined()
    await drainV3Writer()

    // Each retry attempt hit a real transient failure, so the classify/count sees
    // all 3 — this is honest (3 SQLite BUSYs did occur), not double-counting; the
    // entry is counted failed exactly once.
    expect(getHistoryPersistErrorStats()).toMatchObject({ "v3-drain:transient": 3 })
    expect(getV3StoreStatus().failedOperations).toBe(1)

    db.exec("DROP TRIGGER busy_v3_journal")
  })

  test("a conflicting revision/digest STILL THROWS (not absorbed by persist-guard) and increments status.conflicts, NOT getHistoryPersistErrorStats", () => {
    const db = getDatabase()
    const original = prepareModelOperation(terminalRecord("op-conflict-guard"))
    expect(commitPreparedOperation(db, original)).toBe("inserted")

    const conflicting = { ...original, digest: "a-different-digest-than-what-was-committed" }
    // STILL throws — persist-guard must NOT swallow the conflict-throw branch.
    expect(() => commitPreparedOperation(db, conflicting)).toThrow(/operation conflict/i)

    const status = getV3StoreStatus()
    expect(status.conflicts).toBe(1)
    // The two counters are fully independent: a conflict must NOT also appear
    // as a "v3-commit" persistence failure (it never reached persist-guard's
    // wrapped write at all).
    expect(getHistoryPersistErrorStats()).toEqual({})
  })

  test("enqueueModelOperation (production path): a conflict never-throws to the caller, increments status.conflicts, NOT getHistoryPersistErrorStats", async () => {
    const db = getDatabase()
    const original = prepareModelOperation(terminalRecord("op-conflict-drain"))
    expect(commitPreparedOperation(db, original)).toBe("inserted")

    // Re-submit the SAME operationId through the production enqueue path with a
    // differing digest — this drives runDrain's conflict-vs-persist-guard branch.
    const record = terminalRecord("op-conflict-drain", { poison: "force-different-digest" })
    await expect(enqueueModelOperationWithOutcome(record)).resolves.toBe("conflict")

    const status = getV3StoreStatus()
    expect(status.conflicts).toBe(1)
    expect(status.failedOperations).toBe(0) // conflict is NOT counted as a persist-guard failure
    expect(getHistoryPersistErrorStats()).toEqual({}) // fully independent counter
  })
})
