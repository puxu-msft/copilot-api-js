/**
 * Ordered list of forward (001+) schema migrations applied at startup by
 * `applyForwardMigrations`.
 *
 * The conceptual baseline (000) is the openDatabase floor — `SCHEMA_SQL` plus
 * the in-place reconcile in connection.ts (migrateEntriesColumns etc.) — and is
 * deliberately NOT tracked here. Umzug only owns forward DDL from 001 on.
 */

import type { MigrationFn } from "umzug"

import type { SqliteDatabase } from "../driver"

/**
 * A single forward schema migration.
 *
 * `up` is async because Umzug's `MigrationFn` returns `Promise<unknown>`;
 * synchronous DDL is fine inside an async body:
 *   `{ name: "001-x", up: async ({ context }) => { context.exec("ALTER …") } }`
 */
export interface HistoryMigration {
  name: string
  up: MigrationFn<SqliteDatabase>
}

/**
 * INTENTIONALLY EMPTY: the floor already builds the current schema, so there is
 * nothing to migrate yet. The first real schema change lands here as
 * `001-<slug>` with an IDEMPOTENT `up` — SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so additive columns must probe `PRAGMA table_info` first (see
 * `migrateEntriesColumns` for the reusable primitive). Array order IS apply order.
 */
export const MIGRATIONS: Array<HistoryMigration> = []
