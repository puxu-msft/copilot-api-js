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
  // Lineage subsystem removed (dead: zero clustering on real traffic) — drop its
  // orphan tables on existing DBs so they stop occupying space.
  db.exec("DROP TABLE IF EXISTS entry_lineage")
  db.exec("DROP TABLE IF EXISTS entry_produced_tool_ids")
  // Sessions materialized aggregate table removed — operational stats are now
  // telemetry-based; drop the orphan table on existing DBs.
  db.exec("DROP TABLE IF EXISTS sessions")
  // Decommission the legacy trigram FTS + its backing `search_text` column BEFORE
  // any entries_v2 write below — the FTS triggers reference search_text, so a write
  // (reclaimOrphanedActiveRows) would fire a trigger against a half-dropped schema.
  // Must run before migrateEntriesColumns too is fine (it no longer wants search_text).
  dropLegacyFtsAndSearchText(db)
  migrateEntriesColumns(db)
  reclaimOrphanedActiveRows(db)
  maybeVacuumOnStartup(db, dbPath)
  // Seed planner statistics once so the (now several) candidate indexes per
  // query get chosen on selectivity, not heuristics.
  seedAnalyzeIfNeeded(db)
  // NOTE: the search_index + preview_text backfill is NO LONGER run here — it
  // decompresses each entry's lifecycle and would block startup on a large DB. It
  // runs async/chunked/resumable in the BACKGROUND after the server is listening
  // (start.ts → startSearchIndexBackfill → runSearchIndexBackfill), guarded by
  // history_meta(search_index_version).
  if (dbPath !== ":memory:") consola.info(`[history/sqlite] opened ${dbPath}`)
  return db
}

/**
 * One-time decommission of the legacy trigram FTS (table + triggers) and its
 * backing `search_text` column — the search path now uses the content-addressed
 * search_index (msg_blob / req_msg / req_aux). Idempotent + never-throws:
 *   - Skips entirely when neither the FTS table nor the column is present (fresh
 *     DBs created post-decommission, or a DB already migrated).
 *   - STRICT order inside one tx: DROP the triggers FIRST, then the entries_fts
 *     table, THEN `ALTER TABLE … DROP COLUMN search_text` — the triggers reference
 *     the column, so dropping the column while they exist throws "no such column".
 *   - Verifies the column is actually gone afterwards (a silent BUSY would leave
 *     it; the next open retries).
 */
function dropLegacyFtsAndSearchText(database: Database): void {
  try {
    const columns = database.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>
    const hasSearchText = columns.some((c) => c.name === "search_text")
    const hasFts = Boolean(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'entries_fts'").get())
    if (!hasSearchText && !hasFts) return

    const tx = database.transaction(() => {
      database.exec("DROP TRIGGER IF EXISTS entries_v2_fts_ai")
      database.exec("DROP TRIGGER IF EXISTS entries_v2_fts_ad")
      database.exec("DROP TRIGGER IF EXISTS entries_v2_fts_au")
      database.exec("DROP TABLE IF EXISTS entries_fts")
      if (hasSearchText) database.exec("ALTER TABLE entries_v2 DROP COLUMN search_text")
    })
    tx()

    const stillHas = (database.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>).some((c) => c.name === "search_text")
    if (stillHas) consola.warn("[history/sqlite] search_text column still present after DROP (locked?) — will retry on next open")
    else consola.info("[history/sqlite] decommissioned legacy FTS + search_text column")
  } catch (err: unknown) {
    consola.warn("[history/sqlite] FTS/search_text decommission skipped (error — startup continues)", err)
  }
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
  // Count directly rather than via `.run().changes` (kept defensive: any future
  // AFTER-write trigger on entries_v2 would otherwise fold its writes into `changes`).
  const { n } = database.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE ${where}`).get(pid, bootTime) as { n: number }
  if (n === 0) return
  // Backfill a failure reason (richest-data-flow) so the orphaned row surfaces WHY in the
  // list view; COALESCE preserves any real reason already persisted before the crash.
  database
    .prepare(
      `UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at), error_message = COALESCE(error_message, 'orphaned by a prior process — recovered on restart') WHERE ${where}`,
    )
    .run(pid, bootTime)
  consola.info(`[history/sqlite] reclaimed ${n} orphaned active row(s) from a prior process → interrupted`)
}

/**
 * Add post-v2 columns to an existing `entries_v2` table when they are missing,
 * then ensure dependent indexes exist. Safe to run on every open: uses PRAGMA
 * table_info to detect existing columns before ALTER, and CREATE INDEX IF NOT
 * EXISTS for indexes.
 *
 * Columns covered:
 *   - summary columns (message_count, preview_text)
 *   - process-identity columns (pid, boot_time, git_sha)
 *
 * NOTE: `search_text` is deliberately NOT in `wanted` — the legacy FTS column is
 * decommissioned (dropLegacyFtsAndSearchText). Re-adding it here would resurrect
 * the column on every open.
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
    { name: "pid", type: "INTEGER" },
    { name: "boot_time", type: "INTEGER" },
    { name: "git_sha", type: "TEXT" },
    // Debug-pin flag. SQLite permits ALTER ADD COLUMN with a NOT NULL + constant
    // DEFAULT, so existing rows backfill to 0 (unpinned) without a rewrite.
    { name: "pinned", type: "INTEGER NOT NULL DEFAULT 0" },
    { name: "agent_id", type: "TEXT" },
    // Per-request byte sizes (↑request wire / ↓response) + billing multiplier.
    // Additive nullable ALTER ADD COLUMN — old rows backfill NULL (→ undefined on
    // read), no table rewrite. Bytes are DERIVED at serialize time from the stored
    // payloads; multiplier is the write-time-resolved per-request value off the ctx.
    { name: "request_bytes", type: "INTEGER" },
    { name: "response_bytes", type: "INTEGER" },
    { name: "multiplier", type: "REAL" },
    // Best-effort conversation lineage (search_index RFC): the most-recent prior
    // request in the same (session, agent) group. NOT in CREATE TABLE entries_v2
    // — added here so fresh AND existing DBs get it via this single ALTER path.
    // No FK (a dangling ref when the predecessor is reaped is harmless — threading
    // UI handles it); deliberately decoupled from search (never read by search).
    { name: "prev_req_id", type: "TEXT" },
    // Usage net-of-cache normalization marker (mirrors `pinned`'s NOT NULL DEFAULT 0
    // ALTER — SQLite backfills existing rows to 0 without a table rewrite). Rows
    // written by the current code set this to 1 (born net); pre-migration rows keep
    // 0 until usage-normalize-backfill flips them. Also in SCHEMA_SQL for fresh DBs.
    { name: "usage_normalized", type: "INTEGER NOT NULL DEFAULT 0" },
  ]

  for (const col of wanted) {
    if (!existing.has(col.name)) {
      database.exec(`ALTER TABLE entries_v2 ADD COLUMN ${col.name} ${col.type}`)
    }
  }

  database.exec("CREATE INDEX IF NOT EXISTS idx_entries_v2_pid ON entries_v2(pid, started_at DESC)")
  // agent_id index created here (NOT in SCHEMA_SQL): on a pre-agent_id DB, SCHEMA_SQL
  // runs before this migration adds the column, so a CREATE INDEX referencing it there
  // would fail. Composite (session_id, agent_id) serves per-session agent breakdown.
  database.exec("CREATE INDEX IF NOT EXISTS idx_entries_v2_session_agent ON entries_v2(session_id, agent_id, started_at DESC)")
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
