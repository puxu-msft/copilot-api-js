import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  MIGRATIONS,
  type HistoryMigration,
} from "~/lib/history/sqlite/migrations/index"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  ensureV3Schema,
  resetV3WriterForTests,
  V3_SCHEMA_SQL,
} from "~/lib/history/v3/store"

function columns(table: string): Array<string> {
  return (getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name)
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
})

afterEach(() => {
  closeDatabase()
  resetV3WriterForTests()
})

describe("History V3 transport evidence schema migration", () => {
  test("registers the transport-evidence migration after the existing summary migration", () => {
    expect(MIGRATIONS.map(({ name }) => name)).toEqual(["001-operation-summary-projection", "001-transport-evidence-schema"])
  })

  test("upgrades a real schema-5 journal row to schema 6 without rewriting its payload", async () => {
    const db = getDatabase()
    ensureV3Schema(db)
    db.prepare("INSERT OR REPLACE INTO v3_meta(key,value) VALUES('schema_version','5')").run()
    db.exec("DROP TABLE v3_transport_evidence")
    // Recreate the schema-5 journal exactly: no format_version column.
    db.exec("ALTER TABLE v3_journal RENAME TO v3_journal_v6")
    db.exec(`CREATE TABLE v3_journal (
      operation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      phase TEXT NOT NULL,
      payload_gz BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      committed_at INTEGER,
      error TEXT,
      PRIMARY KEY(operation_id, revision)
    )`)
    const payload = new Uint8Array([1, 2, 3, 4])
    db.prepare("INSERT INTO v3_journal VALUES(?,?,?,?,?,?,NULL,NULL)").run("legacy-journal", 7, "legacy-digest", "terminal", payload, 100)
    db.exec("DROP TABLE v3_journal_v6")

    const migration = MIGRATIONS.find(({ name }) => name === "001-transport-evidence-schema") as HistoryMigration
    await applyForwardMigrations(db, [migration])

    expect(columns("v3_journal")).toContain("format_version")
    expect(db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "6" })
    const row = db.prepare("SELECT payload_gz,format_version FROM v3_journal WHERE operation_id='legacy-journal'").get() as {
      payload_gz: Uint8Array
      format_version: number
    }
    expect(row.format_version).toBe(1)
    expect([...row.payload_gz]).toEqual([...payload])
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_transport_evidence'").get()).not.toBeNull()
  })

  test("rolls back the entire migration if a later schema update fails", async () => {
    const db = getDatabase()
    db.exec(V3_SCHEMA_SQL)
    db.prepare("INSERT OR REPLACE INTO v3_meta(key,value) VALUES('schema_version','5')").run()
    db.exec("DROP TABLE v3_transport_evidence")
    db.exec(`CREATE TRIGGER reject_schema_version BEFORE UPDATE OF value ON v3_meta
      WHEN OLD.key='schema_version' BEGIN SELECT RAISE(ABORT, 'schema version blocked'); END;`)
    db.exec(`CREATE TRIGGER reject_schema_insert BEFORE INSERT ON v3_meta
      WHEN NEW.key='schema_version' BEGIN SELECT RAISE(ABORT, 'schema version blocked'); END;`)
    db.exec("ALTER TABLE v3_journal RENAME TO v3_journal_v6")
    db.exec(`CREATE TABLE v3_journal (
      operation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      phase TEXT NOT NULL,
      payload_gz BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      committed_at INTEGER,
      error TEXT,
      PRIMARY KEY(operation_id, revision)
    )`)
    db.exec("DROP TABLE v3_journal_v6")

    const migration = MIGRATIONS.find(({ name }) => name === "001-transport-evidence-schema") as HistoryMigration
    await expect(applyForwardMigrations(db, [migration])).rejects.toThrow(/schema version blocked/i)

    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_transport_evidence'").get()).toBeNull()
    expect(columns("v3_journal")).not.toContain("format_version")
    expect(db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "5" })
  })
})
