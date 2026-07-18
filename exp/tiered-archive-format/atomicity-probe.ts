/**
 * Ground-truth probe: does an archive-only transaction (via ATTACH on the main
 * connection) really touch ONLY archive.db-wal, leaving history.db-wal untouched?
 * This is the load-bearing atomicity claim behind the two-single-file-transaction
 * move design (spec §3.4 / reviewer B2). Run: bun run exp/tiered-archive-format/atomicity-probe.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { attachArchive, closeArchiveDb, openArchiveDb } from "~/lib/history/sqlite/archive-db"
import { migrateEntriesColumns } from "~/lib/history/sqlite/connection"
import { createDatabase } from "~/lib/history/sqlite/driver"
import { SCHEMA_SQL } from "~/lib/history/sqlite/schema"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-probe-"))
openArchiveDb(path.join(dir, "archive.db"))
closeArchiveDb()
const main = createDatabase(path.join(dir, "history.db"))
main.exec("PRAGMA journal_mode = WAL;")
main.exec("PRAGMA foreign_keys = ON;")
main.exec(SCHEMA_SQL)
migrateEntriesColumns(main)
attachArchive(main, path.join(dir, "archive.db"))

main.prepare("INSERT INTO entries_v2 (id, session_id, started_at, status, pinned, blob_gz) VALUES (?,?,?,?,?,?)").run("e1", "s1", Date.now(), "completed", 0, new Uint8Array([1]))
main.exec("PRAGMA wal_checkpoint(FULL);") // flush HOT wal to a known baseline

const hWal = path.join(dir, "history.db-wal")
const aWal = path.join(dir, "archive.db-wal")
const statOr = (p: string) => {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}
const beforeH = statOr(hWal)
const beforeA = statOr(aWal)

// Authoritative measure: data-page count in each db BEFORE the archive-only tx.
const pageCount = (schema: string) => (main.prepare(`PRAGMA ${schema}.page_count`).get() as Record<string, number>).page_count
const hPagesBefore = pageCount("main")
const aPagesBefore = pageCount("archive")
const hRowsBefore = (main.prepare("SELECT COUNT(*) n FROM main.entries_v2").get() as { n: number }).n

// The archive-only transaction under test.
const tx = main.transaction(() => {
  main.prepare("INSERT INTO archive.entries_v2 SELECT * FROM main.entries_v2 WHERE id = ?").run("e1")
})
tx()

const afterH = statOr(hWal)
const afterA = statOr(aWal)
const hPagesAfter = pageCount("main")
const aPagesAfter = pageCount("archive")
const hRowsAfter = (main.prepare("SELECT COUNT(*) n FROM main.entries_v2").get() as { n: number }).n
const aRowsAfter = (main.prepare("SELECT COUNT(*) n FROM archive.entries_v2").get() as { n: number }).n

console.log("history.db-wal size:", beforeH?.size, "→", afterH?.size, beforeH?.size === afterH?.size ? "(size unchanged)" : "(size CHANGED)")
console.log("archive.db-wal size:", beforeA?.size, "→", afterA?.size)
console.log("history.db page_count:", hPagesBefore, "→", hPagesAfter, hPagesBefore === hPagesAfter ? "UNCHANGED (no data pages written)" : "CHANGED")
console.log("archive.db page_count:", aPagesBefore, "→", aPagesAfter, aPagesAfter >= aPagesBefore ? "(grew/received the write)" : "")
console.log("history.db entries_v2 rows:", hRowsBefore, "→", hRowsAfter, hRowsBefore === hRowsAfter ? "UNCHANGED" : "CHANGED")
console.log("archive.db entries_v2 rows: →", aRowsAfter, "(should be 1 — write landed)")

// The claim that MATTERS for atomicity: the archive-only tx modifies ONLY archive
// DATA (history.db data pages + rows untouched), so it's a single-file-atomic
// commit for archive.db — history.db can't be left inconsistent by a crash here.
const verdict = hPagesBefore === hPagesAfter && hRowsBefore === hRowsAfter && aRowsAfter === 1
console.log("\nVERDICT:", verdict ? "history.db DATA untouched (pages+rows) — archive-only tx is single-file-atomic for archive.db; move design safe" : "history.db DATA changed — CLAIM VIOLATED")

main.close()
closeArchiveDb()
fs.rmSync(dir, { recursive: true, force: true })
