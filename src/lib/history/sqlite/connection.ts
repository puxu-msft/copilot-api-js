import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/sqlite/driver"

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
const V3_OWNER_MARKER = "copilot-api-history-v3"

let db: Database | null = null
let openedPath: string | null = null

export function openDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:" && db && openedPath === dbPath) return db
  if (db) closeDatabase()

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const existed = dbPath !== ":memory:" && fs.existsSync(dbPath)
  db = createDatabase(dbPath)
  openedPath = dbPath
  try {
    assertV3Owner(db, existed, dbPath)
  } catch (err) {
    db.close()
    db = null
    openedPath = null
    throw err
  }
  // auto_vacuum MUST be set before ANY other write to the new file — switching
  // to WAL first initializes the DB header and locks auto_vacuum at mode 0
  // (verified empirically). Set on the still-empty file, it makes
  // auto_vacuum=INCREMENTAL persistent with no VACUUM, so the periodic
  // maintenance tick's incremental_vacuum reclaims from the first tick. On an
  // existing DB this is a no-op until a full VACUUM runs (handled by
  // maybeVacuumOnStartup).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL;")
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA foreign_keys = ON;")
  // History V3 is the sole persistence implementation (History V2 removal
  // Phase 4a) — there is now only ONE open path, unconditionally, for every
  // dbPath including ":memory:" (this closes the old C3 trap where ":memory:"
  // used to fall through to the V2 schema branch because it never matched the
  // `history-v3.db` basename check).
  if (dbPath !== ":memory:") consola.info(`[history/v3] opened ${dbPath}`)
  return db
}

/**
 * Refuse to reconcile an existing unowned SQLite artifact as V3. This closes the
 * remaining escape hatch where a test seam or future caller could point the V3
 * opener at legacy history.db and trigger DROP/ALTER/VACUUM before detection.
 */
function assertV3Owner(database: Database, existed: boolean, dbPath: string): void {
  if (!existed || dbPath === ":memory:") {
    database.exec("CREATE TABLE IF NOT EXISTS history_store_identity (owner TEXT PRIMARY KEY)")
    database.prepare("INSERT OR IGNORE INTO history_store_identity (owner) VALUES (?)").run(V3_OWNER_MARKER)
    return
  }
  const identityTable = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'history_store_identity'").get()
  const owner = identityTable ? (database.prepare("SELECT owner FROM history_store_identity LIMIT 1").get() as { owner?: string } | undefined)?.owner : undefined
  if (owner !== V3_OWNER_MARKER) throw new Error(`[history/v3] refusing to open unowned existing database: ${dbPath}`)
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
export function maybeVacuumOnStartup(database: Database, dbPath: string): void {
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
    // VACUUM rewrote the ENTIRE db into the -wal file (WAL mode), so the -wal now
    // sits at a ~full-db high-water mark (observed: a 26 GB -wal after a 25 GB
    // VACUUM). A PASSIVE checkpoint — all the reaper ever runs — NEVER ftruncates
    // the -wal file; only TRUNCATE reclaims its bytes on disk. We are still
    // single-connection at startup (server not yet listening) so TRUNCATE takes
    // its exclusive moment uncontended and shrinks the -wal back to zero. Without
    // this the multi-GB WAL persists on disk indefinitely.
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);")
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
export function seedAnalyzeIfNeeded(database: Database): void {
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
