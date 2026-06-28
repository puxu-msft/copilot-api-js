/**
 * Legacy in-place decommission: a DB that still carries the OLD trigram FTS
 * (`entries_fts` external-content table + 3 triggers referencing `search_text`)
 * AND the `search_text` column must be dropped cleanly on the next `openDatabase`.
 *
 * This is the path that runs ONCE on a real production DB the first time it opens
 * with the post-FTS code. The ordering is load-bearing: the triggers reference
 * `search_text`, so `DROP COLUMN search_text` throws "no such column" unless the
 * triggers are dropped first — `dropLegacyFtsAndSearchText` does trigger→table→
 * column in one tx. The fresh-DB decommission test cannot cover this because a
 * fresh DB never has the legacy schema to drop; this seeds it explicitly.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"

/** Re-create the legacy trigram FTS schema (deleted from SCHEMA_SQL in P3) on an open DB. */
function injectLegacyFts(): void {
  const db = getDatabase()
  db.exec("ALTER TABLE entries_v2 ADD COLUMN search_text TEXT")
  db.exec(`
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      search_text, preview_text,
      content='entries_v2', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER entries_v2_fts_ai AFTER INSERT ON entries_v2 BEGIN
      INSERT INTO entries_fts(rowid, search_text, preview_text) VALUES (new.rowid, new.search_text, new.preview_text);
    END;
    CREATE TRIGGER entries_v2_fts_ad AFTER DELETE ON entries_v2 BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, search_text, preview_text) VALUES ('delete', old.rowid, old.search_text, old.preview_text);
    END;
    CREATE TRIGGER entries_v2_fts_au AFTER UPDATE ON entries_v2 BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, search_text, preview_text) VALUES ('delete', old.rowid, old.search_text, old.preview_text);
      INSERT INTO entries_fts(rowid, search_text, preview_text) VALUES (new.rowid, new.search_text, new.preview_text);
    END;
  `)
}

function insertRawRow(id: string, searchText: string | null): void {
  getDatabase()
    .prepare("INSERT INTO entries_v2 (id, started_at, status, preview_text, search_text, blob_gz) VALUES (?, ?, 'completed', ?, ?, ?)")
    .run(id, Date.now(), "preview", searchText, new Uint8Array([1, 2, 3]))
}

function tableExists(name: string): boolean {
  return Boolean(getDatabase().prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name = ?").get(name))
}

function columnExists(table: string, column: string): boolean {
  return (getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column)
}

describe("legacy FTS + search_text in-place decommission", () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    closeDatabase()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-legacy-fts-"))
    dbPath = path.join(dir, "history.db")
  })

  afterEach(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a populated legacy DB drops FTS + search_text on reopen, ordering-safe, and writes still work", () => {
    // 1. Fresh open (new schema: no FTS, no search_text).
    openDatabase(dbPath)
    expect(tableExists("entries_fts")).toBe(false)
    expect(columnExists("entries_v2", "search_text")).toBe(false)

    // 2. Re-create the legacy schema + populate it (a row whose INSERT fires the
    //    `ai` trigger into entries_fts → the FTS is non-empty, like production).
    injectLegacyFts()
    expect(columnExists("entries_v2", "search_text")).toBe(true)
    expect(tableExists("entries_fts")).toBe(true)
    expect(() => insertRawRow("legacy-1", "the quick brown fox")).not.toThrow()
    const ftsCount = (getDatabase().prepare("SELECT COUNT(*) AS n FROM entries_fts").get() as { n: number }).n
    expect(ftsCount).toBeGreaterThan(0)

    // 3. Reopen → dropLegacyFtsAndSearchText runs during openDatabase.
    closeDatabase()
    openDatabase(dbPath)

    // 4. The legacy table + column are gone (the trigger→table→column ordering
    //    succeeded; a wrong order would have thrown "no such column" and left them).
    expect(tableExists("entries_fts")).toBe(false)
    expect(columnExists("entries_v2", "search_text")).toBe(false)
    // The pre-existing row survived the column drop.
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM entries_v2").get() as { n: number }).n).toBe(1)

    // 5. A subsequent write must NOT throw — proves the search_text-referencing
    //    triggers are truly gone (else the INSERT fires a trigger into a dropped
    //    table / references a dropped column and throws). This is the production
    //    "finalize keeps working after the one-time migration" guarantee.
    expect(() =>
      getDatabase()
        .prepare("INSERT INTO entries_v2 (id, started_at, status, preview_text, blob_gz) VALUES (?, ?, 'completed', ?, ?)")
        .run("post-drop-1", Date.now(), "preview", new Uint8Array([4, 5, 6])),
    ).not.toThrow()

    // 6. Reopening again is idempotent (nothing left to drop → no-op).
    closeDatabase()
    expect(() => openDatabase(dbPath)).not.toThrow()
    expect(columnExists("entries_v2", "search_text")).toBe(false)
  })
})
