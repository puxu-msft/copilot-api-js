/**
 * archive-db.ts — TIER-1 store skeleton (spec 2026-07-14-history-tiered-archive).
 *
 * Asserts the archive.db opens with the SAME schema floor as history.db PLUS the
 * tier2_manifest table, runs its own forward-migration path without throwing, and
 * can be ATTACHed onto a main connection for the archive read VIEW.
 *
 * Isolation: uses a temp dir (never a real path); closes + rm's after each test.
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

import {
  //
  attachArchive,
  closeArchiveDb,
  getArchiveDb,
  isArchiveOpen,
  migrateArchiveDb,
  openArchiveDb,
  resolveArchiveDbPath,
} from "~/lib/history/sqlite/archive-db"
import { createDatabase } from "~/lib/history/sqlite/driver"

const tmpDirs: Array<string> = []
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "archive-db-test-"))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  closeArchiveDb()
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tableNames(db: ReturnType<typeof getArchiveDb>): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

describe("archive-db skeleton", () => {
  test("opens with the shared schema floor + tier2_manifest", () => {
    openArchiveDb(":memory:")
    const tables = tableNames(getArchiveDb())
    for (const t of ["entries_v2", "entry_stages", "msg_blob", "req_msg", "req_aux", "history_meta", "tier2_manifest"]) {
      expect(tables.has(t)).toBe(true)
    }
  })

  test("tier2_manifest carries the seal-unit locator columns", () => {
    openArchiveDb(":memory:")
    const cols = new Set((getArchiveDb().prepare("PRAGMA table_info(tier2_manifest)").all() as Array<{ name: string }>).map((c) => c.name))
    for (const c of ["entry_id", "session_id", "model", "status", "started_at", "preview_text", "seal_file", "index_in_session"]) {
      expect(cols.has(c)).toBe(true)
    }
  })

  test("isArchiveOpen / getArchiveDb lifecycle", () => {
    expect(isArchiveOpen()).toBe(false)
    openArchiveDb(":memory:")
    expect(isArchiveOpen()).toBe(true)
    closeArchiveDb()
    expect(isArchiveOpen()).toBe(false)
    expect(() => getArchiveDb()).toThrow(/not initialized/)
  })

  test("migrateArchiveDb runs its own forward-migration ledger without throwing", async () => {
    const dir = mkTmp()
    openArchiveDb(path.join(dir, "archive.db"))
    await migrateArchiveDb()
    // history_meta exists as the (independent) ledger table; no throw = wired.
    expect(tableNames(getArchiveDb()).has("history_meta")).toBe(true)
  })

  test("attachArchive lets a main connection query archive tables schema-qualified", () => {
    const dir = mkTmp()
    const archivePath = path.join(dir, "archive.db")
    openArchiveDb(archivePath)
    // seed one archive row via the archive connection
    getArchiveDb()
      .prepare("INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES (?,?,?,?)")
      .run("arch-1", 123, "completed", new Uint8Array([1, 2, 3]))
    closeArchiveDb()

    const main = createDatabase(path.join(dir, "history.db"))
    main.exec("PRAGMA journal_mode = WAL;")
    attachArchive(main, archivePath)
    const row = main.prepare("SELECT id, status FROM archive.entries_v2 WHERE id = ?").get("arch-1") as { id: string; status: string }
    expect(row.id).toBe("arch-1")
    expect(row.status).toBe("completed")
    main.close()
  })

  test("resolveArchiveDbPath defaults to the history.db directory", () => {
    expect(resolveArchiveDbPath("", "/data/app/history.db")).toBe("/data/app/archive.db")
    expect(resolveArchiveDbPath("/custom/arch", "/data/app/history.db")).toBe("/custom/arch/archive.db")
  })
})
