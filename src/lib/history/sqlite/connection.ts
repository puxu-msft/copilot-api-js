import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { getProcessIdentity } from "~/lib/process-identity"

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

/**
 * Milliseconds SQLite will wait for a held lock before returning SQLITE_BUSY
 * ("database is locked"). Defaults to 0 in SQLite, meaning the first writer
 * that loses the race throws immediately and the history entry is dropped.
 *
 * Although the history store uses a single in-process connection (so its own
 * transactions can never overlap on the single-threaded JS event loop), the
 * WAL file on disk can still be locked by *another* connection: an overlapping
 * old process during a restart/hot-reload, an accidental second instance, or
 * an external tool inspecting the DB. With a non-zero timeout SQLite retries
 * the lock internally instead of failing the write outright.
 */
const BUSY_TIMEOUT_MS = 5000

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
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  migrateEntriesColumns(db)
  reclaimOrphanedActiveRows(db)
  if (dbPath !== ":memory:") consola.info(`[history/sqlite] opened ${dbPath}`)
  return db
}

/**
 * Startup orphan recovery (Bug 1): any head row still in a non-terminal state
 * (pending/executing/streaming) that does NOT belong to the current process is
 * a leftover from a process that crashed before finalizing. Flip it to
 * `interrupted` so the request is discoverable (and reaper-eligible) rather than
 * stuck "active" forever. Matched by (pid, boot_time) — a restart that reuses a
 * pid is distinguished by boot_time.
 */
function reclaimOrphanedActiveRows(database: Database): void {
  const { pid, bootTime } = getProcessIdentity()
  const result = database
    .prepare(
      `UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at)
         WHERE status IN ('pending','executing','streaming') AND NOT (pid = ? AND boot_time = ?)`,
    )
    .run(pid, bootTime)
  if (result.changes > 0) consola.info(`[history/sqlite] reclaimed ${result.changes} orphaned active row(s) from a prior process → interrupted`)
}

/**
 * Add post-v2 columns to an existing `entries_v2` table when they are missing,
 * then ensure dependent indexes exist. Safe to run on every open: uses PRAGMA
 * table_info to detect existing columns before ALTER, and CREATE INDEX IF NOT
 * EXISTS for indexes.
 *
 * Columns covered:
 *   - summary columns (message_count, preview_text, search_text)
 *   - process-identity columns (pid, boot_time, git_sha)
 *
 * The pid index is created HERE rather than in SCHEMA_SQL: on a pre-pid
 * database, openDatabase runs SCHEMA_SQL before this migration, so an index on
 * the not-yet-added `pid` column there would fail. Creating it after the ALTER
 * (and unconditionally, guarded by IF NOT EXISTS) covers both fresh databases
 * — where the column came from SCHEMA_SQL's CREATE TABLE — and migrated ones.
 */
function migrateEntriesColumns(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>
  const existing = new Set(columns.map((c) => c.name))

  const wanted: Array<{ name: string; type: string }> = [
    { name: "message_count", type: "INTEGER" },
    { name: "preview_text", type: "TEXT" },
    { name: "search_text", type: "TEXT" },
    { name: "pid", type: "INTEGER" },
    { name: "boot_time", type: "INTEGER" },
    { name: "git_sha", type: "TEXT" },
  ]

  for (const col of wanted) {
    if (!existing.has(col.name)) {
      database.exec(`ALTER TABLE entries_v2 ADD COLUMN ${col.name} ${col.type}`)
    }
  }

  database.exec("CREATE INDEX IF NOT EXISTS idx_entries_v2_pid ON entries_v2(pid, started_at DESC)")
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
