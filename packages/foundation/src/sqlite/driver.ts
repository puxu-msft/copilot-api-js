/**
 * SQLite driver adapter — picks `bun:sqlite` on Bun, `node:sqlite` on Node.
 *
 * Both runtimes ship a built-in SQLite module with mostly-compatible APIs:
 *   - bun:sqlite (Bun ≥1.0)        → `Database` class
 *   - node:sqlite (Node ≥22.5)     → `DatabaseSync` class
 *
 * Differences this module papers over:
 *   - constructor name
 *   - node:sqlite has no `.transaction(fn)` helper — we implement BEGIN/
 *     COMMIT/ROLLBACK manually
 *   - both expose `.exec(sql)` and `.prepare(sql).{all,get,run}(...)`, which
 *     is enough for our use sites
 *
 * Why not better-sqlite3? It is a node-gyp native dep and as of Bun 1.3 is
 * rejected at load time ("`better-sqlite3` is not yet supported in Bun"),
 * which would force users to pick a runtime at install time.
 *
 * The runtime-conditional `createRequire` calls keep the bundler from trying
 * to resolve either module at build time — both are marked as externals in
 * tsdown.config.ts as a belt-and-suspenders measure.
 */

import { createRequire } from "node:module"

const nodeRequire = createRequire(import.meta.url)

/** Statement returned by `db.prepare(sql)`. */
export interface SqliteStatement {
  all(...params: Array<unknown>): Array<unknown>
  get(...params: Array<unknown>): unknown
  run(...params: Array<unknown>): { changes: number; lastInsertRowid: number | bigint }
}

/** Unified driver surface used by the history layer. */
export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
  transaction<T>(fn: () => T): () => T
}

/** Open options every driver must understand — currently just the readonly flag needed
 *  by the history-search sidecar's readonly connection into `history-v3.db` (Phase 0). */
export interface DatabaseOpenOptions {
  readonly?: boolean
}

type DatabaseFactory = (path: string, options?: DatabaseOpenOptions) => SqliteDatabase

let cachedFactory: DatabaseFactory | undefined

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
}

function getFactory(): DatabaseFactory {
  if (cachedFactory) return cachedFactory
  cachedFactory = isBunRuntime() ? bunFactory() : nodeFactory()
  return cachedFactory
}

function bunFactory(): DatabaseFactory {
  // bun:sqlite already matches the SqliteDatabase shape (incl. .transaction).
  // bun:sqlite's option key is `readonly` (lowercase) — passing `readOnly` (the
  // node:sqlite spelling) throws `TypeError: Misspelled option "readOnly" should
  // be "readonly"` (verified empirically against Bun 1.3.14), so the two
  // factories below deliberately use DIFFERENT casings for the same concept.
  const mod = nodeRequire("bun:sqlite") as {
    Database: new (path: string, options?: { readonly?: boolean }) => SqliteDatabase
  }
  return (path, options) => (options ? new mod.Database(path, { readonly: options.readonly ?? false }) : new mod.Database(path))
}

function nodeFactory(): DatabaseFactory {
  // node:sqlite emits an ExperimentalWarning on first import (≥22.5, before
  // it goes GA). Suppress once so we don't spam the operator's logs.
  suppressNodeSqliteExperimentalWarning()
  const mod = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => {
      exec(sql: string): void
      prepare(sql: string): SqliteStatement
      close(): void
    }
  }
  return (path, options) => {
    // node:sqlite's option key is `readOnly` (capital O) — the bun:sqlite spelling
    // (`readonly`) is silently IGNORED (verified empirically against Node 24.16:
    // passing `{ readonly: true }` opens a writable connection with no error), so
    // getting this casing wrong would silently defeat the readonly guarantee
    // instead of throwing — hence the explicit per-runtime key mapping here.
    const inner = options ? new mod.DatabaseSync(path, { readOnly: options.readonly ?? false }) : new mod.DatabaseSync(path)
    return {
      exec: (sql) => inner.exec(sql),
      prepare: (sql) => inner.prepare(sql),
      close: () => inner.close(),
      // Manual transaction wrapper to mirror bun:sqlite / better-sqlite3.
      // Nested transactions are not supported (matches node:sqlite — savepoints
      // would be needed; no current call site nests).
      transaction:
        <T>(fn: () => T) =>
        () => {
          inner.exec("BEGIN")
          try {
            const result = fn()
            inner.exec("COMMIT")
            return result
          } catch (err) {
            try {
              inner.exec("ROLLBACK")
            } catch {
              // Ignore rollback errors — propagate the original failure.
            }
            throw err
          }
        },
    }
  }
}

let warningSuppressed = false
function suppressNodeSqliteExperimentalWarning(): void {
  if (warningSuppressed) return
  warningSuppressed = true
  const originalEmit = process.emit.bind(process)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.emit signature is variadic and overloaded; we just forward through.
  process.emit = function patchedEmit(name: any, ...args: Array<any>): boolean {
    const data = args[0]
    if (name === "warning" && data instanceof Error && data.name === "ExperimentalWarning" && /SQLite/i.test(data.message)) {
      return false
    }
    return originalEmit(name, ...args)
  } as typeof process.emit
}

/** Open a database at the given path using the active runtime's driver. */
export function createDatabase(path: string, options?: DatabaseOpenOptions): SqliteDatabase {
  return getFactory()(path, options)
}
