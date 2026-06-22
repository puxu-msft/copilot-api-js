import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { getProcessIdentity } from "~/lib/process-identity"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "./driver"
import {
  //
  FTS_SCHEMA_SQL,
  SCHEMA_SQL,
} from "./schema"

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

/**
 * Startup VACUUM thresholds. SQLite never returns freed pages to the OS on
 * DELETE without VACUUM/auto_vacuum, so a long-lived history.db drifts to its
 * high-water mark (observed: a 2.17 GB file that was 98.7% freelist dead space
 * holding only ~29 MB of live data). These bound a one-time reclamation at
 * startup. Tuning is intentionally NOT config-exposed — the defaults need no
 * operator attention.
 */
const VACUUM_FREELIST_RATIO = 0.25
const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024
const VACUUM_WARN_BYTES = 1024 * 1024 * 1024

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
  // auto_vacuum MUST be set before ANY other write to the new file — switching
  // to WAL first initializes the DB header and locks auto_vacuum at mode 0
  // (verified empirically). Set on the still-empty file, it makes
  // auto_vacuum=INCREMENTAL persistent with no VACUUM, so the reaper's
  // incremental_vacuum reclaims from the first tick. On an existing DB this is
  // a no-op until a full VACUUM runs (handled by maybeVacuumOnStartup).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;")
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  migrateEntriesColumns(db)
  reclaimOrphanedActiveRows(db)
  maybeVacuumOnStartup(db, dbPath)
  // Build the search index AFTER any startup VACUUM: a full VACUUM renumbers
  // entries_v2's implicit rowid (TEXT PK), and the external-content FTS keys on
  // that rowid — building/rebuilding here guarantees the index reflects the
  // post-VACUUM rowids.
  ensureSearchIndex(db)
  // Seed planner statistics once so the (now several) candidate indexes per
  // query get chosen on selectivity, not heuristics.
  seedAnalyzeIfNeeded(db)
  if (dbPath !== ":memory:") consola.info(`[history/sqlite] opened ${dbPath}`)
  return db
}

/** Read a single-value PRAGMA as an integer (0 if absent / non-numeric). */
function pragmaInt(database: Database, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  if (!row) return 0
  const value = Object.values(row)[0]
  return typeof value === "number" ? value : 0
}

/**
 * One-time space reclamation at startup. Runs a full VACUUM only when the file
 * is meaningfully bloated (freelist ratio ≥ 25% AND ≥ 64 MB reclaimable),
 * which also activates auto_vacuum=INCREMENTAL on a legacy (mode 0) DB so the
 * reaper can keep it bounded thereafter.
 *
 * NEVER throws: reclamation is an optimization and must not block startup —
 * a VACUUM that fails (e.g. SQLITE_BUSY from an overlapping connection during a
 * restart, or insufficient temp disk) logs a warning and startup continues.
 */
function maybeVacuumOnStartup(database: Database, dbPath: string): void {
  if (dbPath === ":memory:") return
  try {
    const pageCount = pragmaInt(database, "page_count")
    const pageSize = pragmaInt(database, "page_size")
    const freelist = pragmaInt(database, "freelist_count")
    if (pageCount <= 0 || pageSize <= 0) return

    const freeBytes = freelist * pageSize
    const totalBytes = pageCount * pageSize
    if (freeBytes < VACUUM_MIN_FREE_BYTES || freelist / pageCount < VACUUM_FREELIST_RATIO) return

    if (totalBytes > VACUUM_WARN_BYTES) {
      consola.warn(
        `[history/sqlite] history.db is ${(totalBytes / 1048576).toFixed(0)}MB with ${(freeBytes / 1048576).toFixed(0)}MB reclaimable; `
          + `a one-time startup VACUUM will block briefly and needs ~equal temp disk. For a very large DB consider offline 'sqlite3 history.db "VACUUM;"'.`,
      )
    }
    // VACUUM cannot run inside a transaction. Checkpoint+truncate the WAL first
    // to shrink it and reduce lock contention with any overlapping connection.
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);")
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;") // activated by the VACUUM below
    database.exec("VACUUM;")
    const afterBytes = pragmaInt(database, "page_count") * pageSize
    // VACUUM renumbers entries_v2's implicit rowid (TEXT PK), invalidating the
    // external-content FTS index which keys on rowid. Rebuild it if it already
    // exists (a first-ever open builds it later in ensureSearchIndex, post-VACUUM).
    rebuildSearchIndexIfPresent(database)
    consola.info(
      `[history/sqlite] startup VACUUM reclaimed ${((totalBytes - afterBytes) / 1048576).toFixed(0)}MB (${(totalBytes / 1048576).toFixed(0)}MB → ${(afterBytes / 1048576).toFixed(0)}MB)`,
    )
  } catch (err: unknown) {
    consola.warn("[history/sqlite] startup VACUUM skipped (error — startup continues)", err)
  }
}

/**
 * Return reaper-freed pages to the OS. Only effective when auto_vacuum is
 * actually INCREMENTAL (mode 2) — on a legacy mode-0 DB that has not yet hit
 * the startup-VACUUM threshold, `incremental_vacuum` is a no-op, so we skip it
 * (and avoid pretending we reclaimed). Cheap; safe to call each reaper tick.
 * Never throws.
 */
export function incrementalVacuum(database: Database): void {
  try {
    if (pragmaInt(database, "auto_vacuum") === 2) database.exec("PRAGMA incremental_vacuum;")
  } catch (err: unknown) {
    consola.warn("[history/sqlite] incremental_vacuum failed", err)
  }
}

/**
 * Create the trigram FTS5 search index (table + sync triggers) and, on a
 * database that predates it, backfill from the existing rows. Must run AFTER
 * migrateEntriesColumns (the triggers reference search_text / preview_text) and
 * AFTER any startup VACUUM (rowid coupling — see schema.ts).
 *
 * Backfill gate: whether the `entries_fts` TABLE existed before this open — NOT
 * `SELECT COUNT(*) FROM entries_fts`. For an external-content FTS table that
 * COUNT reads THROUGH to the content table (entries_v2), so it returns the entry
 * count even when the index itself is empty — gating on it would skip the
 * one-time backfill on every upgrade and leave search returning nothing for all
 * pre-existing rows. A freshly-created index starts empty (triggers only
 * populate FUTURE writes), so existing rows need a one-time 'rebuild'; once the
 * table exists from a prior open the triggers have kept it in sync. Create +
 * backfill run in one transaction so a crash mid-backfill rolls back to "table
 * absent" and the next open retries (instead of stranding a half-built index).
 */
function ensureSearchIndex(database: Database): void {
  // Truthy check — NOT `!== undefined`: bun:sqlite's `.get()` returns `null` for
  // no match while node:sqlite returns `undefined`. A strict `!== undefined`
  // would read Bun's `null` as "exists" and wrongly skip the backfill forever;
  // `Boolean(row)` is falsy for both sentinels.
  const existed = Boolean(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'entries_fts'").get())
  if (existed) {
    // Already built on a prior open; ensure triggers exist (defensive, IF NOT
    // EXISTS) without a backfill — the triggers have maintained the index.
    database.exec(FTS_SCHEMA_SQL)
    return
  }
  const tx = database.transaction(() => {
    database.exec(FTS_SCHEMA_SQL)
    const { n } = database.prepare("SELECT COUNT(*) AS n FROM entries_v2").get() as { n: number }
    if (n > 0) database.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
  })
  tx()
}

/** Rebuild the external-content FTS index from entries_v2 — only if it exists. Used after a rowid-renumbering VACUUM. */
function rebuildSearchIndexIfPresent(database: Database): void {
  const row = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'entries_fts'").get() as { name: string } | undefined
  if (row) database.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
}

/**
 * One-time planner-stats seed: run ANALYZE when no `sqlite_stat1` exists yet, so
 * the (now several) candidate indexes per query are chosen on real selectivity
 * from the first query rather than coarse heuristics. After the first ANALYZE,
 * `sqlite_stat1` exists and ongoing maintenance is handled by `runOptimize` on
 * the reaper tick. Cheap on a bounded table; never throws.
 */
function seedAnalyzeIfNeeded(database: Database): void {
  try {
    const row = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'").get() as { name: string } | undefined
    if (row) return
    database.exec("ANALYZE;")
  } catch (err: unknown) {
    consola.warn("[history/sqlite] initial ANALYZE skipped (error — startup continues)", err)
  }
}

/**
 * Refresh planner statistics incrementally. `PRAGMA optimize` re-ANALYZEs only
 * the tables that changed enough since the last run, so it's cheap to call each
 * reaper tick and keeps a long-lived server's stats current as the table churns.
 * Never throws.
 */
export function runOptimize(database: Database): void {
  try {
    database.exec("PRAGMA optimize;")
  } catch (err: unknown) {
    consola.warn("[history/sqlite] PRAGMA optimize failed", err)
  }
}

/**
 * (pending/executing/streaming) that does NOT belong to the current process is
 * a leftover from a process that crashed before finalizing. Flip it to
 * `interrupted` so the request is discoverable (and reaper-eligible) rather than
 * stuck "active" forever. Matched by (pid, boot_time) — a restart that reuses a
 * pid is distinguished by boot_time.
 */
function reclaimOrphanedActiveRows(database: Database): void {
  const { pid, bootTime } = getProcessIdentity()
  const where = "status IN ('pending','executing','streaming') AND NOT (pid = ? AND boot_time = ?)"
  // Count directly rather than via `.run().changes`: once the entries_fts
  // triggers exist, bun:sqlite folds their trigger-side writes into `changes`.
  // (This runs before ensureSearchIndex today, but counting keeps the log
  // accurate regardless of the open-sequence ordering.)
  const { n } = database.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE ${where}`).get(pid, bootTime) as { n: number }
  if (n === 0) return
  database.prepare(`UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at) WHERE ${where}`).run(pid, bootTime)
  consola.info(`[history/sqlite] reclaimed ${n} orphaned active row(s) from a prior process → interrupted`)
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
  // Partial index over ONLY the active (non-terminal) rows — a handful at any
  // instant regardless of total retention. Makes the reclaim scans
  // (reclaimStaleActiveRows / reclaimOrphanedActiveRows, both filtering on this
  // exact status set) O(active) instead of O(table), and stays tiny + cheap to
  // maintain. The WHERE must match those queries' status set verbatim for the
  // planner to use it.
  database.exec("CREATE INDEX IF NOT EXISTS idx_entries_v2_active ON entries_v2(pid, started_at) WHERE status IN ('pending','executing','streaming')")
}

/**
 * Checkpoint the WAL back into the main DB. PASSIVE: does as much as possible
 * WITHOUT taking an exclusive lock, so it never blocks readers/writers and never
 * needs the busy_timeout. Called each reaper tick to keep the `-wal` file from
 * ballooning (observed: a 400 MB WAL when checkpoints were starved by long-lived
 * readers) — an oversized WAL lengthens lock windows and raises the SQLITE_BUSY
 * odds the persist-guard then has to absorb. Never throws.
 */
export function checkpointWal(database: Database): void {
  try {
    database.exec("PRAGMA wal_checkpoint(PASSIVE);")
  } catch (err: unknown) {
    consola.warn("[history/sqlite] wal_checkpoint failed", err)
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
