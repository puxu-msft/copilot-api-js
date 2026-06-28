/**
 * Umzug forward-migration runner + history_meta-backed storage, in ISOLATION.
 *
 * Uses a bare in-memory DB straight from the driver (NOT openDatabase) so the
 * floor is absent — this is exactly the chicken-egg surface: Umzug calls
 * `storage.executed()` before any migration runs, and on a floor-less DB
 * `history_meta` does not exist yet. The storage's constructor guard
 * (CREATE TABLE IF NOT EXISTS) plus the executed() table-missing guard must make
 * the runner self-sufficient regardless of open order.
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
import { Umzug } from "umzug"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/history/sqlite/driver"
import {
  //
  getMeta,
  MIGRATIONS_RUN_KEY,
} from "~/lib/history/sqlite/meta"
import {
  //
  type HistoryMigration,
  MIGRATIONS,
} from "~/lib/history/sqlite/migrations/index"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { HistoryMetaStorage } from "~/lib/history/sqlite/migrations/storage"

let openDbs: Array<SqliteDatabase> = []

function freshDb(): SqliteDatabase {
  const db = createDatabase(":memory:")
  openDbs.push(db)
  return db
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
  test("empty MIGRATIONS is a no-op on a bare DB (must not throw)", async () => {
    // Guard: the shipped list is empty (the floor is the baseline).
    expect(MIGRATIONS).toEqual([])

    const db = freshDb()
    await applyForwardMigrations(db) // no floor, no migrations → no-op, no throw

    const storage = new HistoryMetaStorage(db)
    expect(await storage.executed()).toEqual([])
  })

  test("ordered apply + run-once + persistent ledger (temporary test migrations)", async () => {
    const db = freshDb()
    const applied: Array<string> = []
    const testMigrations: Array<HistoryMigration> = [
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

    // Drive the same machinery as applyForwardMigrations, but with injectable
    // migrations (the shipped MIGRATIONS is intentionally empty).
    const run = async (): Promise<Array<string>> => {
      const umzug = new Umzug<SqliteDatabase>({
        migrations: testMigrations,
        context: db,
        storage: new HistoryMetaStorage(db),
        logger: undefined,
      })
      return (await umzug.up()).map((m) => m.name)
    }

    // Ordered apply.
    expect(await run()).toEqual(["001-create-t", "002-add-col"])
    expect(applied).toEqual(["001", "002"])

    // Schema actually changed.
    const cols = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(["x", "y"])

    // Run-once: a second up applies nothing and does NOT re-run the up bodies.
    expect(await run()).toEqual([])
    expect(applied).toEqual(["001", "002"])

    // Ledger persisted in history_meta.
    expect(JSON.parse(getMeta(db, MIGRATIONS_RUN_KEY) ?? "[]")).toEqual(["001-create-t", "002-add-col"])
  })
})
