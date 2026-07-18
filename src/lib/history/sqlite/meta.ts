/**
 * `history_meta` key/value accessors + DDL — the Umzug forward-migration
 * ledger (History V2 removal Phase 4a/4d). `history_meta` used to also carry
 * a handful of V2-only backfill completion flags/cursors (search_index,
 * usage-normalize, cache-write, legacy-stage, response-preview, calibration);
 * those constants were deleted along with their (also-deleted) V2 backfill
 * modules. What remains is the generic KV primitive + the migration ledger
 * key, which `migrations/storage.ts` (`HistoryMetaStorage`) depends on.
 */

import type { Database } from "./connection"

/**
 * Single-source DDL for the `history_meta` key/value table. Was previously
 * defined in the (now-deleted) `schema.ts` and shared with `SCHEMA_SQL` (the
 * V2 openDatabase floor); now lives here as the sole definition, consumed by
 * `HistoryMetaStorage`'s bare-DB guard (the migration runner) via
 * `applyForwardMigrations`.
 */
export const HISTORY_META_DDL = `CREATE TABLE IF NOT EXISTS history_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`

/**
 * `history_meta` key: the Umzug forward-migration ledger — a JSON `string[]` of
 * applied migration names (see migrations/storage.ts). Kept in history_meta so
 * schema-migration provenance lives in a single ledger.
 */
export const MIGRATIONS_RUN_KEY = "schema_migrations"

/** Read one history_meta value (null when absent). */
export function getMeta(db: Database, key: string): string | null {
  // .get() returns null on bun:sqlite / undefined on node:sqlite when no row
  // matches; the `row ?` below treats both falsy results as "absent".
  const row = db.prepare("SELECT value FROM history_meta WHERE key = ?").get(key) as { value: string | null } | null | undefined
  return row ? row.value : null
}

/** Upsert one history_meta value. */
export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT INTO history_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

/** Delete one history_meta key (no-op when absent). */
export function deleteMeta(db: Database, key: string): void {
  db.prepare("DELETE FROM history_meta WHERE key = ?").run(key)
}
