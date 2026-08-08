/**
 * Umzug forward-migration runner + history_meta-backed storage, in ISOLATION.
 *
 * Uses a bare in-memory DB straight from the driver (NOT openDatabase) so the
 * floor is absent — this is exactly the chicken-egg surface: Umzug calls
 * `storage.executed()` before any migration runs, and on a floor-less DB
 * `history_meta` does not exist yet. The storage's constructor guard plus the
 * executed() table-missing guard must make the runner self-sufficient regardless
 * of open order.
 *
 * Tests drive the REAL exported `applyForwardMigrations` (via its injectable
 * `migrations` arg), not a copy of its wiring, so the production runner — logger
 * adapter, storage construction, up() — is the unit under test.
 *
 * No history runtime / module-global singletons are touched (every test gets its
 * own throwaway `:memory:` db), so no isolation fixture is needed.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getMeta,
  MIGRATIONS_RUN_KEY,
  setMeta,
} from "~/lib/history/sqlite/meta"
import {
  //
  type HistoryMigration,
  MIGRATIONS,
  sqlMigration,
} from "~/lib/history/sqlite/migrations/index"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { HistoryMetaStorage } from "~/lib/history/sqlite/migrations/storage"
import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/sqlite/driver"

let openDbs: Array<SqliteDatabase> = []

function freshDb(): SqliteDatabase {
  const db = createDatabase(":memory:")
  openDbs.push(db)
  return db
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name))
}

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
})

describe("HistoryMetaStorage", () => {
  test("executed() returns [] on a bare DB (constructor creates history_meta)", async () => {
    const db = freshDb()
    const storage = new HistoryMetaStorage(db)
    expect(await storage.executed()).toEqual([])
  })

  test("table-missing guard: executed() returns [] even if history_meta is dropped", async () => {
    const db = freshDb()
    const storage = new HistoryMetaStorage(db)
    db.exec("DROP TABLE history_meta")
    expect(await storage.executed()).toEqual([])
  })

  test("readLedger tolerates corrupt / non-array / mixed values", async () => {
    const db = freshDb()
    const storage = new HistoryMetaStorage(db)

    setMeta(db, MIGRATIONS_RUN_KEY, "{not json")
    expect(await storage.executed()).toEqual([])

    setMeta(db, MIGRATIONS_RUN_KEY, JSON.stringify({ a: 1 })) // non-array
    expect(await storage.executed()).toEqual([])

    setMeta(db, MIGRATIONS_RUN_KEY, JSON.stringify(["001-a", 5, "002-b"])) // mixed
    expect(await storage.executed()).toEqual(["001-a", "002-b"])
  })

  test("log/unlog round-trips through the history_meta ledger", async () => {
    const db = freshDb()
    const storage = new HistoryMetaStorage(db)

    await storage.logMigration({ name: "001-a" })
    await storage.logMigration({ name: "002-b" })
    expect(await storage.executed()).toEqual(["001-a", "002-b"])
    expect(getMeta(db, MIGRATIONS_RUN_KEY)).toBe(JSON.stringify(["001-a", "002-b"]))

    // Idempotent: logging the same name again does not duplicate it.
    await storage.logMigration({ name: "001-a" })
    expect(await storage.executed()).toEqual(["001-a", "002-b"])

    await storage.unlogMigration({ name: "001-a" })
    expect(await storage.executed()).toEqual(["002-b"])
  })
})

describe("applyForwardMigrations", () => {
  test("an explicitly empty migration list is a no-op on a bare DB", async () => {
    expect(MIGRATIONS.map((migration) => migration.name)).toEqual([
      "001-operation-summary-projection",
      "001-transport-evidence-schema",
      "002-summary-integrity-invalidation",
    ])

    const db = freshDb()
    await applyForwardMigrations(db, [])

    expect(await new HistoryMetaStorage(db).executed()).toEqual([])
  })

  test("ordered apply + run-once + persistent ledger (real runner, injected migrations)", async () => {
    const db = freshDb()
    const applied: Array<string> = []
    // 002's ALTER requires 001's CREATE, so the assertion is order-sensitive: a
    // reversed apply order would throw "no such table: t".
    const migrations: Array<HistoryMigration> = [
      {
        name: "001-create-t",
        up: async ({ context }) => {
          context.exec("CREATE TABLE t (x TEXT)")
          applied.push("001")
        },
      },
      {
        name: "002-add-col",
        up: async ({ context }) => {
          context.exec("ALTER TABLE t ADD COLUMN y TEXT")
          applied.push("002")
        },
      },
    ]

    await applyForwardMigrations(db, migrations)
    expect(applied).toEqual(["001", "002"]) // ordered
    const cols = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(["x", "y"]) // schema actually changed
    expect(await new HistoryMetaStorage(db).executed()).toEqual(["001-create-t", "002-add-col"])

    // Run-once: a second call applies nothing and does NOT re-run the up bodies.
    await applyForwardMigrations(db, migrations)
    expect(applied).toEqual(["001", "002"])
    expect(JSON.parse(getMeta(db, MIGRATIONS_RUN_KEY) ?? "[]")).toEqual(["001-create-t", "002-add-col"])
  })

  test("a throwing migration RETHROWS and is not logged (hard-abort contract)", async () => {
    const db = freshDb()
    const migrations: Array<HistoryMigration> = [
      {
        name: "001-boom",
        up: async () => {
          throw new Error("boom")
        },
      },
    ]
    await expect(applyForwardMigrations(db, migrations)).rejects.toThrow("boom")
    // Failed migration stays pending (unlogged) so it re-runs next start.
    expect(await new HistoryMetaStorage(db).executed()).toEqual([])
  })

  test("sqlMigration rolls back a mid-body throw (no partial schema → retryable, not wedged)", async () => {
    const db = freshDb()
    const migrations: Array<HistoryMigration> = [
      sqlMigration("001-partial", (d) => {
        d.exec("CREATE TABLE a (x TEXT)")
        throw new Error("mid-body failure after first statement")
      }),
    ]
    await expect(applyForwardMigrations(db, migrations)).rejects.toThrow("mid-body")
    // The transaction rolled back, so the early CREATE did NOT persist — a retry
    // on the next start re-runs cleanly instead of dying on "table a already exists".
    expect(tableExists(db, "a")).toBe(false)
    expect(await new HistoryMetaStorage(db).executed()).toEqual([])

    // Sanity: a clean sqlMigration commits its whole body.
    const ok: Array<HistoryMigration> = [
      sqlMigration("001-ok", (d) => {
        d.exec("CREATE TABLE b (x TEXT)")
        d.exec("ALTER TABLE b ADD COLUMN y TEXT")
      }),
    ]
    await applyForwardMigrations(db, ok)
    expect(tableExists(db, "b")).toBe(true)
    expect(await new HistoryMetaStorage(db).executed()).toEqual(["001-ok"])
  })
})
