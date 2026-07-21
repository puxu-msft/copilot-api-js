/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 0 — readonly store read surface.
 *
 * Proves the blocker the plan's review found: `history-v3.db` must be openable
 * READONLY (for the future search sidecar, tailing the same on-disk file from a
 * separate process) and a record must be rebuildable from that connection alone,
 * with NO write ever attempted against it — `openDatabase()`'s ordinary sequence
 * unconditionally runs `maybeVacuumOnStartup`/`seedAnalyzeIfNeeded` (VACUUM/ANALYZE),
 * both of which throw `attempt to write a readonly database` on a readonly handle
 * (confirmed empirically against bun:sqlite 1.3.14 before writing this test).
 *
 * This is a positive regression AND a negative-baseline test at once (empirical-
 * verification discipline): it first proves the OLD path (`openDatabase` reused
 * on a readonly-opened connection) really does throw, before proving the NEW path
 * (`openDatabaseReadonly`) does not.
 */

import {
  //
  afterEach,
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
  closeDatabase,
  openDatabase,
  openDatabaseReadonly,
} from "~/lib/history/sqlite/connection"
import { projectSearchableText } from "~/lib/history/v3/projection"
import {
  //
  commitPreparedOperation,
  getV3StoredOperation,
  hydrateManifest,
  listV3StoredOperations,
  prepareModelOperation,
  visitV3StoredOperations,
} from "~/lib/history/v3/store"
import { createDatabase } from "~/lib/sqlite/driver"

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-readonly-"))
  tmpDirs.push(dir)
  return path.join(dir, "history-v3.db")
}

/** Builds a real, current-schema terminal record — mirrors `store.it.test.ts`'s helper. */
function terminalRecord(id: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload(
    { messages: [{ role: "user", content: "what is the searchable prompt" }] },
    { origin: { stage: "ingress", track: "client" } },
  )
  const response = recorder.registerPayload(
    { content: [{ type: "text", text: "here is the searchable reply" }] },
    { origin: { stage: "client-egress", track: "client" } },
  )
  recorder.recordIngress({ request: { payload: request } })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(attempt, { verdict: "committed" })
  recorder.recordEgress({ upstream: {}, client: { payload: response } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

/** Populate a fresh on-disk V3 db with one committed operation, using the real production
 *  write path (`openDatabase` → `commitPreparedOperation`), then close it cleanly. */
function seedRealV3Db(dbPath: string, operationId: string): void {
  const db = openDatabase(dbPath)
  const record = terminalRecord(operationId)
  commitPreparedOperation(db, prepareModelOperation(record))
  closeDatabase()
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("readonly store read surface (Phase 0)", () => {
  test("negative baseline: the ordinary open sequence throws on a readonly connection", () => {
    const dbPath = freshDbPath()
    seedRealV3Db(dbPath, "baseline-op")

    // Raw readonly driver connection (bypassing openDatabaseReadonly entirely) — proves
    // the write-pragma sequence really is incompatible with readonly, not just "assumed".
    const readonlyRaw = createDatabase(dbPath, { readonly: true })
    expect(() => readonlyRaw.exec("VACUUM;")).toThrow(/attempt to write a readonly database/i)
    expect(() => readonlyRaw.exec("ANALYZE;")).toThrow(/attempt to write a readonly database/i)
    readonlyRaw.close()
  })

  test("openDatabaseReadonly opens without throwing and never attempts a write", () => {
    const dbPath = freshDbPath()
    seedRealV3Db(dbPath, "readonly-open-op")

    let readonlyDb: ReturnType<typeof openDatabaseReadonly> | undefined
    expect(() => {
      readonlyDb = openDatabaseReadonly(dbPath)
    }).not.toThrow()
    expect(readonlyDb).toBeDefined()

    // Confirms the connection really IS readonly (not silently opened writable by
    // a runtime-mismatched option key — the exact bug this plan's blocker warns about).
    expect(() => readonlyDb!.exec("INSERT INTO v3_meta(key,value) VALUES('probe','1')")).toThrow(/attempt to write a readonly database/i)

    readonlyDb!.close()
  })

  test("rebuilds a full record from the readonly connection via exported hydrateManifest + db-param read functions", () => {
    const dbPath = freshDbPath()
    seedRealV3Db(dbPath, "rebuild-op")

    const readonlyDb = openDatabaseReadonly(dbPath)

    const viaGet = getV3StoredOperation("rebuild-op", readonlyDb)
    expect(viaGet?.record.identity.operationId).toBe("rebuild-op")

    const viaList = listV3StoredOperations("generation", 100, readonlyDb)
    expect(viaList.map((stored) => stored.record.identity.operationId)).toEqual(["rebuild-op"])

    const visited: Array<string> = []
    visitV3StoredOperations((stored) => visited.push(stored.record.identity.operationId), "generation", 64, readonlyDb)
    expect(visited).toEqual(["rebuild-op"])

    // hydrateManifest itself, directly against the raw manifest blob — the sidecar's
    // actual entry point once it tails `v3_operations` itself (Phase 1).
    const row = readonlyDb.prepare("SELECT manifest_gz FROM v3_operations WHERE operation_id=?").get("rebuild-op") as { manifest_gz: Uint8Array }
    const hydrated = hydrateManifest(readonlyDb, row.manifest_gz)
    expect(hydrated.identity.operationId).toBe("rebuild-op")

    readonlyDb.close()
  })

  test("projectSearchableText extracts conversation + response text from a readonly-rebuilt record", () => {
    const dbPath = freshDbPath()
    seedRealV3Db(dbPath, "searchable-op")

    const readonlyDb = openDatabaseReadonly(dbPath)
    const stored = getV3StoredOperation("searchable-op", readonlyDb)!
    readonlyDb.close()

    const text = projectSearchableText(stored.record)
    expect(text).toContain("what is the searchable prompt")
    expect(text).toContain("here is the searchable reply")
  })

  test("openDatabase() still defaults db-param read functions to the module singleton (backward compatible)", () => {
    const dbPath = freshDbPath()
    seedRealV3Db(dbPath, "singleton-op")
    openDatabase(dbPath)

    // No explicit db argument — must resolve against the process-wide singleton,
    // exactly as every existing production call site does today.
    const stored = getV3StoredOperation("singleton-op")
    expect(stored?.record.identity.operationId).toBe("singleton-op")
  })

  test("refuses to open a not-yet-initialized / unowned database readonly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-readonly-unowned-"))
    tmpDirs.push(dir)
    const dbPath = path.join(dir, "unowned.db")
    // Create a plain sqlite file with no V3 owner marker at all (e.g. a stray/foreign file).
    const raw = createDatabase(dbPath)
    raw.exec("CREATE TABLE unrelated(a)")
    raw.close()

    expect(() => openDatabaseReadonly(dbPath)).toThrow(/refusing to open unowned or not-yet-initialized database readonly/i)
  })

  test("rejects ':memory:' — readonly is only meaningful for an on-disk file", () => {
    expect(() => openDatabaseReadonly(":memory:")).toThrow(/requires an on-disk path/i)
  })
})
