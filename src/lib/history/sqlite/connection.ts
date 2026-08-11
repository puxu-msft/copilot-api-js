import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/sqlite/driver"

import {
  //
  detachHistoryReadDatabaseForTests,
  installHistoryReadDatabase,
  peekHistoryReadDatabase,
} from "./read-connection"

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
  // Assign only after a successful open, so a rejected artifact leaves the
  // singleton null rather than pointing at a handle we already closed.
  const opened = openOwnedHistoryDatabase(dbPath)
  db = opened
  openedPath = dbPath
  return opened
}

/**
 * Open a fully-initialized V3 write handle that the CALLER owns — same sequence as
 * {@link openDatabase} (owner check, WAL/pragmas, startup reclamation, planner seed)
 * but WITHOUT touching the module singleton.
 *
 * This is what the History persistence Worker uses: the Worker thread owns its own
 * handle and must not publish it through a process-global accessor, because the
 * write-first migration stage deliberately keeps a *separate* main-thread readonly
 * connection (`read-connection.ts`) alive at the same time. Routing both through one
 * singleton would silently make "which handle am I holding" depend on module-load
 * order across two threads.
 */
export function openOwnedHistoryDatabase(dbPath: string): Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const existed = dbPath !== ":memory:" && fs.existsSync(dbPath)
  const database = createDatabase(dbPath)
  // The WHOLE initialization sequence is guarded, not just the owner check. Before this
  // opener existed, a half-initialized handle was already published to the module
  // singleton and `closeDatabase()` could still reach it; an owned handle has no such
  // second owner, so a throwing PRAGMA would strand the file descriptor and its SQLite
  // locks with nobody left holding a reference.
  try {
    assertV3Owner(database, existed, dbPath)
    // auto_vacuum MUST be set before ANY other write to the new file — switching
    // to WAL first initializes the DB header and locks auto_vacuum at mode 0
    // (verified empirically). Set on the still-empty file, it makes
    // auto_vacuum=INCREMENTAL persistent with no VACUUM, so the periodic
    // maintenance tick's incremental_vacuum reclaims from the first tick. On an
    // existing DB this is a no-op until a full VACUUM runs (handled by
    // maybeVacuumOnStartup).
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;")
    database.exec("PRAGMA journal_mode = WAL;")
    database.exec("PRAGMA synchronous = NORMAL;")
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    database.exec("PRAGMA foreign_keys = ON;")
    // History V3 is the sole persistence implementation (History V2 removal
    // Phase 4a) — there is now only ONE open path, unconditionally, for every
    // dbPath including ":memory:" (this closes the old C3 trap where ":memory:"
    // used to fall through to the V2 schema branch because it never matched the
    // `history-v3.db` basename check).
    //
    // DB-health (Phase 4b): V2's row-level "存活共享库跳过" liveness gate is still deliberately NOT adopted, and its reasoning still holds — V3's `v3_operations` only ever stores terminal (committed) rows, with no pending/executing/streaming concept, so there is no "another process may still be writing an in-flight row" risk to defer around (plan §6 / §4b).
    //
    // That reasoning was, however, applied to the wrong hazard. What a VACUUM has to defer around is not the STATE OF ANY ROW but the LOCK: it holds an exclusive write lock for as long as it takes to rewrite the whole file, which during a restart overlap starves the predecessor's writes past their 5s busy_timeout.
    // `maybeVacuumOnStartup` therefore carries its own gate, keyed on live connections rather than on row state — see the probe there.
    maybeVacuumOnStartup(database, dbPath)
    seedAnalyzeIfNeeded(database)
  } catch (err) {
    database.close()
    throw err
  }
  if (dbPath !== ":memory:") consola.info(`[history/v3] opened ${dbPath}`)
  return database
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
  const owner =
    identityTable ? (database.prepare("SELECT owner FROM history_store_identity LIMIT 1").get() as { owner?: string } | undefined)?.owner : undefined
  if (owner !== V3_OWNER_MARKER) throw new Error(`[history/v3] refusing to open unowned existing database: ${dbPath}`)
}

/**
 * Open a READONLY connection to an existing `history-v3.db` for a reader that must
 * never risk a write — e.g. the history-search sidecar (out-of-process search plan
 * Phase 0), which self-tails the DB from a separate OS process and must be
 * physically incapable of blocking/corrupting the primary writer.
 *
 * Deliberately does NOT reuse `openDatabase()`'s sequence: that path unconditionally
 * runs `maybeVacuumOnStartup`/`seedAnalyzeIfNeeded` (VACUUM/ANALYZE — confirmed
 * empirically to throw `attempt to write a readonly database` on a readonly
 * connection) and (via callers of `ensureV3Schema`) a migration branch that ALTERs
 * tables whenever the on-disk schema isn't already at the exact current
 * `SCHEMA_VERSION` — a real possibility for a reader racing a mid-deploy writer.
 * A readonly opener must be incapable of attempting ANY of those writes, so this
 * path only ever issues `PRAGMA busy_timeout` (read-safe — WAL readers still need
 * SQLITE_BUSY retries against a concurrent writer's checkpoint) plus a read-only
 * owner-marker check. No auto_vacuum, no VACUUM, no ANALYZE, no schema migration.
 *
 * Returns an independent handle, NOT tied to the module-singleton tracked by
 * `openDatabase`/`getDatabase` — the caller owns it and must `.close()` it
 * (mirrors `createDatabase` itself, not the singleton accessor).
 */
export function openDatabaseReadonly(dbPath: string): Database {
  if (dbPath === ":memory:") throw new Error("[history/sqlite] openDatabaseReadonly requires an on-disk path, not ':memory:'")
  const database = createDatabase(dbPath, { readonly: true })
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  assertV3OwnerReadonly(database, dbPath)
  return database
}

/**
 * Readonly counterpart to `assertV3Owner` — SELECT only, never CREATE/INSERT the
 * identity marker table. A readonly connection could not perform that write anyway,
 * but making the read-only intent explicit here (rather than relying on the write
 * throwing) keeps the contract self-documenting and gives a clearer error message
 * than a raw SQLite "attempt to write a readonly database".
 */
function assertV3OwnerReadonly(database: Database, dbPath: string): void {
  const identityTable = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'history_store_identity'").get()
  const owner =
    identityTable ? (database.prepare("SELECT owner FROM history_store_identity LIMIT 1").get() as { owner?: string } | undefined)?.owner : undefined
  if (owner !== V3_OWNER_MARKER) throw new Error(`[history/sqlite] refusing to open unowned or not-yet-initialized database readonly: ${dbPath}`)
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
    // Probe for lock contention BEFORE committing to a VACUUM.
    // A TRUNCATE checkpoint wants the same exclusive moment a VACUUM then holds for far longer, so a non-zero `busy` is the cheapest available answer to "can I get that moment right now?".
    // Unlike a pidfile check this works identically on all three run paths — bare / systemd / pm2 — including the supervisor ones that deliberately write no pidfile, which are exactly the paths where an overlap is guaranteed by design.
    // This matters most during a graceful-restart overlap: the successor opens the db while the predecessor is still serving at FULL SPEED (it has not even been sent the handoff signal yet — that comes later, at `notifyReady`), and a VACUUM here would hold the write lock far past the 5s `busy_timeout` the predecessor's writes are given, turning its in-flight persistence into SQLITE_BUSY failures.
    // SCOPE — do not read this as "is another process using the db?". Measured, one condition varied at a time: no peer -> `{busy:0,log:0,checkpointed:0}`; peer connection OPEN but holding NO transaction -> `busy:0`, i.e. LET THROUGH; peer holding a read transaction -> `{busy:1,log:1,checkpointed:0}`; peer transaction committed -> back to `busy:0`. A non-empty WAL is a second necessary condition: with nothing to truncate the checkpoint is trivially `busy:0`.
    // So this NARROWS the hazard window rather than closing it — an idle-at-this-instant predecessor is let through and can resume writing mid-VACUUM. It is kept because the cost is ~zero (the call already happened for WAL shrink) and it cannot misfire destructively: a false `busy` only defers reclamation to a later start. Closing the window for real needs the read/write split (see docs/todo/deferred-backlog.md).
    // Probe with a ZERO busy_timeout: we want the answer now, not after the 5s the rest of this connection is configured to wait. A probe that blocked for the full busy_timeout on every overlapping start would itself be the regression (measured: it makes the open path hang 5s and times out the covering test).
    // The restore MUST be in a finally: `.get()` can throw outright under lock contention (measured: `SQLiteError`, not always a populated `busy` column), and the outer catch below swallows it — leaving this process's main History connection permanently at busy_timeout=0, where every later concurrent write fails instantly instead of waiting.
    let checkpoint: { busy?: number } | null = null
    try {
      database.exec("PRAGMA busy_timeout = 0;")
      checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get() as { busy?: number } | null
    } finally {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    }
    if (checkpoint?.busy) {
      consola.info(
        `[history/sqlite] skipping the startup VACUUM of ${dbPath}: another connection is holding a transaction (graceful-restart overlap). `
          + `Reclamation runs on a later start, once this process has the database to itself.`,
      )
      return
    }
    database.exec("PRAGMA auto_vacuum = INCREMENTAL;") // activated by the VACUUM below
    database.exec("VACUUM;")
    // VACUUM rewrote the ENTIRE db into the -wal file (WAL mode), so the -wal now
    // sits at a ~full-db high-water mark (observed: a 26 GB -wal after a 25 GB
    // VACUUM). A PASSIVE checkpoint — all the reaper ever runs — NEVER ftruncates
    // the -wal file; only TRUNCATE reclaims its bytes on disk. The probe above
    // found no peer holding a transaction AT THAT INSTANT, which is the best this
    // gate can say (see its SCOPE note) — not that we hold the database alone. If a
    // peer has since taken one, this checkpoint simply does not truncate; the VACUUM
    // it follows has already succeeded either way. Without it the multi-GB WAL
    // persists on disk indefinitely.
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
  // Symmetric counterpart to `openInMemoryDatabase`, which PUBLISHES this singleton as the process-wide read handle. Closing it without withdrawing that publication leaves a closed handle installed, and the next `getHistoryReadDatabase()` hands it to a query that dies with "Cannot use a closed database" — far from here, in code that did nothing wrong. Only withdraw OUR publication: a readonly handle opened by `initHistory` belongs to it, not to us.
  if (peekHistoryReadDatabase() === db) detachHistoryReadDatabaseForTests()
  try {
    db.close()
  } catch (err: unknown) {
    consola.warn("[history/sqlite] error closing db", err)
  }
  db = null
  openedPath = null
}

/**
 * For tests: open an in-memory db.
 *
 * Also publishes it as the process-wide READ handle. Since the Batch 2b cutover the app's query paths resolve `getHistoryReadDatabase()`, not this singleton, so a test that populates an in-memory database and then exercises a query would otherwise read through a handle that was never installed. The two handles are deliberately the same object here: an in-memory database belongs to exactly one connection, so there is no second one to open, and these tests are asserting SQL rather than the read/write split.
 */
export function openInMemoryDatabase(): Database {
  // The previously published handle is this same singleton, which `openDatabase` is about to close; detach rather than close, or the close below runs twice.
  detachHistoryReadDatabaseForTests()
  const database = openDatabase(":memory:")
  installHistoryReadDatabase(database)
  return database
}
