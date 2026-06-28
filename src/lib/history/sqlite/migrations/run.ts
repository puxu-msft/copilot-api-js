/**
 * Forward (001+) schema-migration runner.
 *
 * Called once at startup AFTER `openDatabase` has built the floor (so
 * `history_meta` already exists) and BEFORE the server starts listening. Umzug
 * records applied migration names in the `history_meta` ledger
 * (HistoryMetaStorage), so each migration runs exactly once across restarts.
 */

import consola from "consola"
import { Umzug } from "umzug"

import type { SqliteDatabase } from "../driver"

import { MIGRATIONS } from "./index"
import { HistoryMetaStorage } from "./storage"

/**
 * Apply every pending forward migration against an already-open DB.
 *
 * Failure policy: RETHROW (do NOT swallow). Unlike the data-layer backfills —
 * which never-throw because a missing derived column is recoverable — schema DDL
 * is foundational: a half-applied migration leaves the DB in a shape the rest of
 * the code assumes away. The caller (start.ts) turns a throw into a hard
 * refuse-to-start, which is strictly safer than serving on a half-migrated schema.
 */
export async function applyForwardMigrations(db: SqliteDatabase): Promise<void> {
  const umzug = new Umzug<SqliteDatabase>({
    migrations: MIGRATIONS,
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
