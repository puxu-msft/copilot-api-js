/**
 * `history_meta` key/value accessors + the search_index migration constants.
 *
 * `history_meta` (schema.ts) holds the search_index backfill's completion flag
 * and resumable progress cursor. Kept tiny and dependency-free so both the
 * backfill (writer) and the search-query read path (reader, for partial-result
 * gating) share one source of truth.
 */

import type { Database } from "./connection"

/** Completion-flag value written once the backfill has indexed every entry. */
export const SEARCH_INDEX_VERSION = "1"

/** `history_meta` key: set to SEARCH_INDEX_VERSION only when the full backfill completes. */
export const SEARCH_INDEX_VERSION_KEY = "search_index_version"

/** `history_meta` key: resumable backfill progress (the last processed started_at). */
export const SEARCH_BACKFILL_CURSOR_KEY = "search_index_backfill_cursor"

/**
 * `history_meta` key: the dedup ratio (total req_msg references / distinct
 * msg_blob). A healthy index dedups ~40× (empirically measured 42.7×); a ratio
 * near 1 means cross-turn dedup failed — almost always an incomplete
 * volatile-key strip list re-hashing the same message every turn (the silent
 * bloat this feature exists to prevent). Observable tripwire, not load-bearing.
 */
export const SEARCH_INDEX_DEDUP_RATIO_KEY = "search_index_dedup_ratio"

/**
 * `history_meta` key: the Umzug forward-migration ledger — a JSON `string[]` of
 * applied migration names (see migrations/storage.ts). Kept in history_meta so
 * schema-migration provenance lives in the same single ledger as the search
 * index flags rather than a separate migrations table.
 */
export const MIGRATIONS_RUN_KEY = "schema_migrations"

/** Completion-flag value written once the usage net-of-cache backfill finishes. */
export const USAGE_NORMALIZE_VERSION = "1"

/** `history_meta` key: set to USAGE_NORMALIZE_VERSION only when the full usage backfill completes. */
export const USAGE_NORMALIZE_VERSION_KEY = "usage_normalize_version"

/** `history_meta` key: resumable usage-backfill progress (the last processed started_at). */
export const USAGE_NORMALIZE_CURSOR_KEY = "usage_normalize_backfill_cursor"

/** Completion-flag value written once the legacy-stage → client/upstream-stage migration finishes. */
export const STAGE_MIGRATE_VERSION = "1"

/** `history_meta` key: set to STAGE_MIGRATE_VERSION only when the full legacy-stage migration completes. */
export const STAGE_MIGRATE_VERSION_KEY = "stage_migrate_version"

/** `history_meta` key: resumable legacy-stage-migration progress (the last processed started_at). */
export const STAGE_MIGRATE_CURSOR_KEY = "stage_migrate_backfill_cursor"

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

/** True once the full backfill has completed (search reads are then complete, not partial). */
export function isSearchIndexComplete(db: Database): boolean {
  return getMeta(db, SEARCH_INDEX_VERSION_KEY) === SEARCH_INDEX_VERSION
}
