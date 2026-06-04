import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "./driver"
import { SCHEMA_SQL } from "./schema"

/**
 * SQLite-backed history store. The driver layer abstracts over the runtime —
 * bun:sqlite on Bun, node:sqlite on Node — so callers see a single class.
 */
export type Database = SqliteDatabase

let db: Database | null = null
let openedPath: string | null = null

export function openDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:" && db && openedPath === dbPath) return db
  if (db) closeDatabase()

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  db = createDatabase(dbPath)
  openedPath = dbPath
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  migrateEntriesSummaryColumns(db)
  if (dbPath !== ":memory:") consola.info(`[history/sqlite] opened ${dbPath}`)
  return db
}

/**
 * Add summary columns (message_count, preview_text, search_text) to an
 * existing `entries` table if they are missing. Safe to run on every open:
 * uses PRAGMA table_info to detect existing columns before ALTER.
 */
function migrateEntriesSummaryColumns(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>
  const existing = new Set(columns.map((c) => c.name))

  const wanted: Array<{ name: string; type: string }> = [
    { name: "message_count", type: "INTEGER" },
    { name: "preview_text", type: "TEXT" },
    { name: "search_text", type: "TEXT" },
  ]

  for (const col of wanted) {
    if (!existing.has(col.name)) {
      database.exec(`ALTER TABLE entries ADD COLUMN ${col.name} ${col.type}`)
    }
  }
}

export function getDatabase(): Database {
  if (!db) throw new Error("[history/sqlite] database not initialized; call openDatabase first")
  return db
}

export function isDatabaseOpen(): boolean {
  return db !== null
}

export function closeDatabase(): void {
  if (!db) return
  try {
    db.close()
  } catch (err: unknown) {
    consola.warn("[history/sqlite] error closing db", err)
  }
  db = null
  openedPath = null
}

/** For tests: open an in-memory db. */
export function openInMemoryDatabase(): Database {
  return openDatabase(":memory:")
}
