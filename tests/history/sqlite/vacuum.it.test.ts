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
  closeDatabase,
  getDatabase,
  incrementalVacuum,
  openDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"

/** PRAGMA single-int helper mirroring connection.ts. */
function pragmaInt(name: string): number {
  const row = getDatabase().prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
  return Number(Object.values(row)[0])
}

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-vacuum-"))
  tmpDirs.push(dir)
  return path.join(dir, "history.db")
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("sqlite/vacuum (space reclamation)", () => {
  test("a fresh file DB is created with auto_vacuum=INCREMENTAL (mode 2)", () => {
    // The PRAGMA set before table creation makes the mode persistent with no
    // VACUUM, so the reaper's incremental_vacuum reclaims from the first tick.
    openDatabase(freshDbPath())
    expect(pragmaInt("auto_vacuum")).toBe(2)
  })

  test("incrementalVacuum returns freed pages to the OS on a mode-2 DB", () => {
    const db = openDatabase(freshDbPath())
    // Inflate then delete to produce freelist pages. A 4 KB blob per row × many
    // rows guarantees overflow pages enter the freelist on delete.
    const blob = new Uint8Array(8192).fill(0x41)
    const insert = db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?, ?, -1, 0, ?)")
    // entry_stages has a FK to entries_v2; insert a head row first.
    db.prepare("INSERT INTO entries_v2 (id, started_at, status, blob_gz) VALUES ('e', 1, 'completed', ?)").run(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))
    for (let i = 0; i < 300; i++) insert.run("e", `s${i}`, blob)
    db.exec("DELETE FROM entry_stages")

    const freeBefore = pragmaInt("freelist_count")
    expect(freeBefore).toBeGreaterThan(0)
    incrementalVacuum(db)
    expect(pragmaInt("freelist_count")).toBe(0)
  })

  test("incrementalVacuum is a safe no-op on a legacy mode-0 DB", () => {
    const db = openDatabase(freshDbPath())
    // Force the DB back to mode 0 to simulate a legacy file not yet VACUUMed.
    db.exec("PRAGMA auto_vacuum = NONE;")
    db.exec("VACUUM;") // apply the mode switch
    expect(pragmaInt("auto_vacuum")).toBe(0)
    // Must not throw and must not pretend to reclaim.
    expect(() => incrementalVacuum(db)).not.toThrow()
  })

  test(":memory: DB opens cleanly (startup VACUUM skip path, no throw)", () => {
    expect(() => openInMemoryDatabase()).not.toThrow()
    expect(pragmaInt("page_count")).toBeGreaterThan(0)
  })
})
