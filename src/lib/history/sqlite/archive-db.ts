import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { state } from "~/lib/state"

import type { Database } from "./connection"

import { migrateEntriesColumns } from "./connection"
import { createDatabase } from "./driver"
import { applyForwardMigrations } from "./migrations/run"
import { SCHEMA_SQL, TIER2_MANIFEST_DDL } from "./schema"

/**
 * archive.db — the TIER-1 store of the tiered cold-archive (spec
 * 2026-07-14-history-tiered-archive). A SEPARATE SQLite file from history.db,
 * reusing the exact same schema (entries_v2 / entry_stages / msg_blob / req_msg
 * / req_aux) so a HOT→TIER-1 move is a same-shape row transfer, PLUS the
 * `tier2_manifest` table that indexes entries already sealed into tier-2 cold
 * units.
 *
 * Kept as its own module (not folded into connection.ts) so the archive
 * connection has an independent lifecycle: opened lazily when archiving is
 * enabled, ATTACH-able to the main connection for the archive read VIEW, and
 * running its OWN forward-migration ledger (its own history_meta.schema_migrations)
 * so the two DBs stay schema-synced without sharing a ledger (RFC H1).
 */

const BUSY_TIMEOUT_MS = 5000

let db: Database | null = null
let openedPath: string | null = null

/** Resolve the archive.db path from config: `<archive.dir or history.db dir>/archive.db`. */
export function resolveArchiveDbPath(dir: string, historyDbPath: string): string {
  const baseDir = dir !== "" ? dir : path.dirname(historyDbPath)
  return path.join(baseDir, "archive.db")
}

/** Directory holding archive.db + the numbered tier-2 seal-unit files. */
export function resolveArchiveDir(dir: string, historyDbPath: string): string {
  return dir !== "" ? dir : path.dirname(historyDbPath)
}

/**
 * Open (or reuse) the archive.db connection. Sets the same durability PRAGMAs as
 * history.db, installs the shared SCHEMA_SQL floor + the tier2_manifest table.
 * Forward migrations (001+) are applied separately via `migrateArchiveDb` after
 * open (async), mirroring history.db's initHistory → applyForwardMigrations split.
 */
export function openArchiveDb(dbPath: string): Database {
  if (dbPath !== ":memory:" && db && openedPath === dbPath) return db
  if (db) closeArchiveDb()

  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = createDatabase(dbPath)
  openedPath = dbPath
  // auto_vacuum must be set before any other write to a new file (see connection.ts).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;")
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  // archive.db MUST carry the SAME entries_v2 shape as history.db, including the
  // ALTER-added columns (pid / pinned / agent_id / raw_path / *_bytes / …) that
  // live in migrateEntriesColumns, NOT in SCHEMA_SQL's CREATE TABLE. Otherwise a
  // HOT→TIER-1 `INSERT INTO archive.entries_v2 SELECT * FROM main.entries_v2`
  // would fail on a column-count mismatch. Reuse the exact same migration so the
  // two files stay column-identical (single source of truth).
  migrateEntriesColumns(db)
  db.exec(TIER2_MANIFEST_DDL)
  if (dbPath !== ":memory:") consola.info(`[history/archive] opened ${dbPath}`)
  return db
}

/**
 * Apply forward (001+) schema migrations to archive.db with its OWN independent
 * ledger (archive.db's history_meta.schema_migrations). Same migration set as
 * history.db, so the two files stay schema-synced. Async + never-throw-on-open
 * mirrors history.db's `applyForwardMigrations` call site. Call after openArchiveDb.
 */
export async function migrateArchiveDb(): Promise<void> {
  await applyForwardMigrations(getArchiveDb())
}

/**
 * ATTACH archive.db onto the main history.db connection AS `archive`, so the
 * archive read VIEW can query `archive.entries_v2` / `archive.tier2_manifest`
 * with schema-qualified table names. The archive VIEW and the HOT view query
 * DIFFERENT databases and NEVER co-list (spec §2 view-domain split), so this is
 * a single ATTACH (never approaches SQLite's 10-attach limit).
 */
export function attachArchive(main: Database, archiveDbPath: string): void {
  main.prepare("ATTACH DATABASE ? AS archive").run(archiveDbPath)
}

export function getArchiveDb(): Database {
  if (!db) throw new Error("[history/archive] archive.db not initialized; call openArchiveDb first")
  return db
}

export function isArchiveOpen(): boolean {
  return db !== null
}

export function closeArchiveDb(): void {
  if (!db) return
  try {
    db.close()
  } catch (err: unknown) {
    consola.warn("[history/archive] error closing archive.db", err)
  }
  db = null
  openedPath = null
}

/** Open archive.db at the config-resolved path (convenience wrapper for startup wiring). */
export function openConfiguredArchiveDb(): Database {
  const dbPath = resolveArchiveDbPath(state.historyArchiveDir, state.historyDbPath)
  return openArchiveDb(dbPath)
}

/** For tests: open an in-memory archive db. */
export function openInMemoryArchiveDb(): Database {
  return openArchiveDb(":memory:")
}
