import {
  //
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
import { SCHEMA_SQL } from "~/lib/history/sqlite/schema"

interface SqliteTableRow {
  name: string
  sql: string | null
}

interface IndexRow {
  name: string
}

interface ColumnRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

describe("lineage schema — DDL provisioning", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("creates entry_lineage table with expected columns", () => {
    const db = getDatabase()
    const cols = db.prepare("PRAGMA table_info(entry_lineage)").all() as Array<ColumnRow>
    const byName = new Map(cols.map((c) => [c.name, c]))

    expect(byName.get("entry_id")?.pk).toBe(1)
    expect(byName.get("schema_version")?.notnull).toBe(1)
    expect(byName.get("root_hash")?.notnull).toBe(1)
    expect(byName.get("turn_hashes_blob")?.type).toBe("BLOB")
    expect(byName.get("turn_hashes_blob")?.notnull).toBe(1)
    expect(byName.get("post_response_hash")?.notnull).toBe(0)
    expect(byName.get("back_tool_use_id")?.notnull).toBe(0)
    expect(byName.get("computed_at")?.notnull).toBe(1)
  })

  test("creates entry_produced_tool_ids with composite PK", () => {
    const db = getDatabase()
    const cols = db.prepare("PRAGMA table_info(entry_produced_tool_ids)").all() as Array<ColumnRow>
    const byName = new Map(cols.map((c) => [c.name, c]))
    // Both columns should be part of the PK.
    expect(byName.get("tool_use_id")?.pk).toBeGreaterThan(0)
    expect(byName.get("entry_id")?.pk).toBeGreaterThan(0)
  })

  test("creates the 5 expected lineage indexes", () => {
    const db = getDatabase()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_entry_lineage_%' OR name LIKE 'idx_produced_tool_%'")
      .all() as Array<IndexRow>
    const names = new Set(indexes.map((i) => i.name))
    expect(names.has("idx_entry_lineage_post")).toBe(true)
    expect(names.has("idx_entry_lineage_root")).toBe(true)
    expect(names.has("idx_entry_lineage_back")).toBe(true)
    expect(names.has("idx_produced_tool_only")).toBe(true)
    expect(names.has("idx_produced_tool_entry")).toBe(true)
  })

  test("DDL is idempotent — re-running SCHEMA_SQL does not error", () => {
    const db = getDatabase()
    // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS guarantees this.
    // Re-running the imported SQL is the closest we get to simulating a
    // second openDatabase() call against an existing schema.
    expect(() => {
      db.exec(SCHEMA_SQL)
    }).not.toThrow()
  })

  test("FOREIGN KEY ON DELETE CASCADE removes lineage rows when entry is deleted", () => {
    const db = getDatabase()
    // Insert minimal entries_v2 row.
    db.exec(`INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('test_e1', 0, 'completed', x'00')`)
    db.exec(
      `INSERT INTO entry_lineage (entry_id, schema_version, root_hash, turn_hashes_blob, post_response_hash, back_tool_use_id, computed_at) `
        + `VALUES ('test_e1', 1, 'root_x', x'00', 'post_x', NULL, 0)`,
    )
    db.exec(`INSERT INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES ('toolu_X', 'test_e1')`)

    const before = db.prepare("SELECT COUNT(*) as n FROM entry_lineage").get() as { n: number }
    expect(before.n).toBe(1)

    db.exec(`DELETE FROM entries_v2 WHERE id = 'test_e1'`)

    const afterLineage = db.prepare("SELECT COUNT(*) as n FROM entry_lineage").get() as { n: number }
    expect(afterLineage.n).toBe(0)
    const afterTools = db.prepare("SELECT COUNT(*) as n FROM entry_produced_tool_ids").get() as { n: number }
    expect(afterTools.n).toBe(0)
  })

  test("composite PK rejects exact duplicate (tool_use_id, entry_id) but accepts same tool_use_id under different entry", () => {
    const db = getDatabase()
    db.exec(`INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('e1', 0, 'completed', x'00')`)
    db.exec(`INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('e2', 0, 'completed', x'00')`)
    db.exec(`INSERT INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES ('toolu_A', 'e1')`)
    // Same id under different entry — allowed.
    expect(() => db.exec(`INSERT INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES ('toolu_A', 'e2')`)).not.toThrow()
    // Exact duplicate — rejected by PK constraint.
    expect(() => db.exec(`INSERT INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES ('toolu_A', 'e1')`)).toThrow()
    // But INSERT OR IGNORE — the production write path's mode — is silent.
    expect(() => db.exec(`INSERT OR IGNORE INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES ('toolu_A', 'e1')`)).not.toThrow()
  })

  test("sqlite_master describes entry_lineage table (sanity for downstream tooling)", () => {
    const db = getDatabase()
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('entry_lineage','entry_produced_tool_ids')")
      .all() as Array<SqliteTableRow>
    expect(tables.length).toBe(2)
  })
})
