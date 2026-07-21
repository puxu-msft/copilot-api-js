/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 1 — the sidecar daemon core: readonly-tail `history-v3.db` -> hydrate the
 * canonical `ModelOperationRecord` from its manifest -> project the searchable
 * text -> upsert into the (already-built, native) Tantivy `HistoryIndex` -> debounced
 * flush. Pure library surface, independently drivable by tests — process entry
 * point / UDS wiring / supervisor land in later phases (P2/P3), NOT here.
 *
 * Cursor discipline (plan "architecture decision 2", reviewed):
 *  - Keyset `(committed_at, operation_id)`, NEVER a raw rowid. `committed_at` is the
 *    INSERT-time wall clock written by `commitPreparedOperation` (`Date.now()`),
 *    monotonic by construction; `operation_id` breaks ties within the same
 *    millisecond. A rowid cursor would silently skip/reprocess rows across a
 *    `VACUUM` (SQLite's own docs: VACUUM "may" renumber rowids on a table without an
 *    INTEGER PRIMARY KEY -- confirmed empirically to actually happen here).
 *  - append-once premise: `v3_operations` never gets an UPDATE that changes
 *    `manifest_gz` (the sole input to `projectSearchableText`) for an already-committed
 *    row -- `commitPreparedOperation` only INSERTs once per operation_id and treats a
 *    resubmit as either `idempotent` (identical digest, no-op) or a thrown conflict
 *    (never a silent overwrite). So a keyset tail can never miss a "content-changing
 *    revision" because there is no such revision. Locked as a regression in
 *    `tests/history/search/daemon.it.test.ts`.
 *
 * Autocommit discipline (plan warning, reviewed): each tail round issues ONE
 * `SELECT ... LIMIT n` as an independent readonly statement -- there is NEVER a
 * long-lived open transaction (`BEGIN`) held across a round. A long snapshot would
 * pin the primary writer's WAL at that point forever, starving its PASSIVE
 * checkpoints (`checkpointWal` in connection.ts) and letting the -wal file grow
 * unboundedly. This module deliberately has no `db.transaction(...)` anywhere.
 */

import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import type { NativeHistoryIndex } from "~/lib/history/search-native"
import type { Database } from "~/lib/history/sqlite/connection"

import { openDatabaseReadonly } from "~/lib/history/sqlite/connection"
import { projectSearchableText } from "~/lib/history/v3/projection"
import { hydrateManifest } from "~/lib/history/v3/store"

/** Keyset tail cursor -- the LAST row this daemon has successfully upserted (not
 *  flushed; flush is a separate, cheaper commit boundary). `null`/absent means "tail
 *  from the very beginning". */
export interface TailCursor {
  committedAt: number
  operationId: string
}

const CURSOR_FILE_NAME = "tail-cursor.json"

function cursorPath(indexPath: string): string {
  return path.join(indexPath, CURSOR_FILE_NAME)
}

/**
 * Read the persisted tail cursor for a given index directory. Returns `null` when
 * absent (fresh index -- tail from the start) or corrupt (never-throw: a damaged
 * cursor file must degrade to "re-tail from the beginning", not crash the daemon --
 * duplicate upserts are idempotent via `HistoryIndex::upsert`'s delete-then-add, so a
 * full re-tail is safe, merely slower).
 */
export function readTailCursor(indexPath: string): TailCursor | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath(indexPath), "utf8")) as Partial<TailCursor>
    if (typeof raw.committedAt !== "number" || typeof raw.operationId !== "string") return null
    return { committedAt: raw.committedAt, operationId: raw.operationId }
  } catch {
    return null // ENOENT / corrupt JSON / missing fields -- treat as "no cursor yet".
  }
}

/**
 * Persist the tail cursor atomically (write-to-tmp then rename -- mirrors
 * `src/lib/restart/pidfile.ts`'s `writePidfile`), so a crash mid-write can never
 * leave a half-written cursor file for the next restart to choke on. Never-throw: a
 * failed cursor write only means the NEXT tail round re-processes a bit more (still
 * idempotent), not a hard daemon failure.
 */
export function writeTailCursor(indexPath: string, cursor: TailCursor): void {
  try {
    fs.mkdirSync(indexPath, { recursive: true })
    const target = cursorPath(indexPath)
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cursor), "utf8")
    fs.renameSync(tmp, target)
  } catch (error) {
    consola.warn(`[history-search-daemon] failed to persist tail cursor (non-fatal -- next round re-tails further back): ${indexPath}`, error)
  }
}

export interface HistorySearchDaemonOptions {
  /** Path to the on-disk `history-v3.db` to tail readonly. */
  dbPath: string
  /** Path to the Tantivy index directory (also where the tail cursor is persisted). */
  indexPath: string
  /** Already-constructed native index handle (caller owns its lifecycle: flush/close). */
  index: NativeHistoryIndex
  /** Rows fetched per tail round. */
  pageSize?: number
}

export interface TailRoundResult {
  /** Number of operations upserted into the index this round. */
  processed: number
  /** Cursor AFTER this round (persisted to disk); `null` if nothing has ever been tailed. */
  cursor: TailCursor | null
}

const DEFAULT_PAGE_SIZE = 256

interface TailRow {
  operation_id: string
  committed_at: number
  kind: string
  created_at: number
  manifest_gz: Uint8Array
}

/**
 * One independently-drivable sidecar daemon instance. Construction does NOT open a
 * database connection eagerly (`readonlyDb` is created lazily on first `tailOnce`) so
 * a caller building a daemon before `history-v3.db` exists (an ordering race the real
 * process entry point / supervisor must tolerate, P2/P3) does not fail at construction
 * time -- only a `tailOnce()` call needs the file to exist.
 */
export interface HistorySearchDaemon {
  /**
   * Run ONE tail round: read the persisted cursor, SELECT the next page of rows
   * strictly after it (single autocommit statement, no open transaction), hydrate +
   * project + upsert each into the native index, then persist the new cursor. Loops
   * internally until a page comes back short of `pageSize` (i.e. drains everything
   * currently available), so one call always catches the daemon fully up to "now".
   *
   * Does NOT call `index.flush()` -- flush cadence (debounce/batch) is the caller's
   * concern (mirrors `search-tantivy.ts`'s split between upsert and flush).
   */
  tailOnce: () => Promise<TailRoundResult>
  /** Current in-memory cursor (mirrors the last-persisted value). */
  getCursor: () => TailCursor | null
  /** Release the daemon's own readonly db handle (does NOT touch `options.index` --
   *  the caller constructed it and owns its flush/close lifecycle). */
  close: () => void
}

/**
 * Construct a standalone sidecar daemon. Pure library surface -- no process
 * lifecycle, no UDS, no supervisor (those are Phase 2/3). The caller supplies an
 * already-open native `HistoryIndex` handle (constructed via
 * `getNativeHistorySearch()` + `new native.HistoryIndex(indexPath)`) so this module
 * stays agnostic of native-module loading/caching policy.
 */
export function createHistorySearchDaemon(options: HistorySearchDaemonOptions): HistorySearchDaemon {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  let readonlyDb: Database | undefined
  let cursor: TailCursor | null = readTailCursor(options.indexPath)

  function db(): Database {
    // Constructed lazily (see interface doc) and cached for the daemon's lifetime --
    // one long-lived readonly connection tails many rounds; each round is still its
    // own independent autocommit statement (never a held BEGIN) against it.
    readonlyDb ??= openDatabaseReadonly(options.dbPath)
    return readonlyDb
  }

  async function tailOnce(): Promise<TailRoundResult> {
    const connection = db()
    let processed = 0
    // Loop until a page comes back short of `pageSize` -- drains everything currently
    // committed, not just one page, so a single `tailOnce()` call always catches up
    // fully (the caller does not need to know how many rounds "catching up" takes).
    for (;;) {
      const rows =
        cursor === null ?
          (connection
            .prepare("SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations ORDER BY committed_at,operation_id LIMIT ?")
            .all(pageSize) as Array<TailRow>)
        : (connection
            .prepare(
              "SELECT operation_id,committed_at,kind,created_at,manifest_gz FROM v3_operations WHERE (committed_at,operation_id) > (?,?) ORDER BY committed_at,operation_id LIMIT ?",
            )
            .all(cursor.committedAt, cursor.operationId, pageSize) as Array<TailRow>)
      if (rows.length === 0) break

      for (const row of rows) {
        const record = hydrateManifest(connection, row.manifest_gz)
        const content = projectSearchableText(record)
        await options.index.upsert(row.operation_id, row.kind, row.created_at, content)
        cursor = { committedAt: row.committed_at, operationId: row.operation_id }
        processed++
      }

      if (rows.length < pageSize) break
    }

    if (processed > 0 && cursor !== null) writeTailCursor(options.indexPath, cursor)
    return { processed, cursor }
  }

  function getCursor(): TailCursor | null {
    return cursor
  }

  function close(): void {
    readonlyDb?.close()
    readonlyDb = undefined
  }

  return { tailOnce, getCursor, close }
}
