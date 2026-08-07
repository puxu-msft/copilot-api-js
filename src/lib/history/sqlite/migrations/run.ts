/**
 * Forward (001+) schema-migration runner.
 *
 * Called once at startup AFTER `openDatabase` has built the floor (so
 * `history_meta` already exists) and BEFORE the server starts listening. Umzug
 * records applied migration names in the `history_meta` ledger
 * (HistoryMetaStorage), so each migration runs exactly once across restarts.
 *
 * SINGLE-WRITER ASSUMPTION (no concurrent-migration lock): Umzug's `FileLocker`
 * is opt-in and deliberately NOT wired here. The floor (000) plus a fully
 * IDEMPOTENT first batch make overlapping restarts safe today, but a future
 * NON-idempotent 001+ DDL would have no protection against two processes
 * migrating the same DB at once. The project is single-process by design and an
 * overlapping restart is the edge; the standing rule is therefore: every 001+
 * `up` MUST be idempotent (SQLite has no `ADD COLUMN IF NOT EXISTS`, so additive
 * columns probe `PRAGMA table_info` first — see `migrateEntriesColumns`). If a
 * genuinely non-idempotent migration ever becomes unavoidable, wire `FileLocker`
 * then. (RFC migration-framework-umzug.md OQ-D.)
 */

import consola from "consola"
import { Umzug } from "umzug"

import type { SqliteDatabase } from "~/lib/sqlite/driver"

import {
  //
  type HistoryMigration,
  MIGRATIONS,
} from "./index"
import { HistoryMetaStorage } from "./storage"

/**
 * Apply every pending forward migration against an already-open DB.
 *
 * `migrations` defaults to the shipped `MIGRATIONS`; it is injectable so tests
 * can drive the REAL runner (logger adapter + storage construction + up()) with
 * independent migration lists.
 *
 * Failure policy: RETHROW (do NOT swallow). Unlike the data-layer backfills —
 * which never-throw because a missing derived column is recoverable — schema DDL
 * is foundational: a half-applied migration leaves the DB in a shape the rest of
 * the code assumes away. The caller (start.ts) turns a throw into a hard
 * refuse-to-start, which is strictly safer than serving on a half-migrated schema.
 * (Umzug records a migration as applied only after its `up` resolves, so a failed
 * migration stays pending and re-runs next start — which is why DDL bodies must be
 * atomic/re-entrant; see `sqlMigration`.)
 */
export async function applyForwardMigrations(db: SqliteDatabase, migrations: Array<HistoryMigration> = MIGRATIONS): Promise<void> {
  const umzug = new Umzug<SqliteDatabase>({
    migrations,
    context: db,
    storage: new HistoryMetaStorage(db),
    // Umzug passes a structured object to the logger; consola would render it as
    // a raw object, so stringify it into our [history/sqlite] channel.
    logger: {
      info: (m) => consola.info(`[history/sqlite] migrate ${JSON.stringify(m)}`),
      warn: (m) => consola.warn(`[history/sqlite] migrate ${JSON.stringify(m)}`),
      error: (m) => consola.error(`[history/sqlite] migrate ${JSON.stringify(m)}`),
      debug: (m) => consola.debug(`[history/sqlite] migrate ${JSON.stringify(m)}`),
    },
  })
  await umzug.up()
}
