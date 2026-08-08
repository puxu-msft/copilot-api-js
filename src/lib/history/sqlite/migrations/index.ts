/**
 * Ordered list of forward (001+) schema migrations applied at startup by
 * `applyForwardMigrations`.
 *
 * The conceptual baseline (000) is the openDatabase floor — `SCHEMA_SQL` plus
 * the in-place reconcile in connection.ts (migrateEntriesColumns etc.) — and is
 * deliberately NOT tracked here. Umzug only owns forward DDL from 001 on.
 */

import type { MigrationFn } from "umzug"

import type { SqliteDatabase } from "~/lib/sqlite/driver"

import { SUMMARY_PROJECTION_MIGRATION_SQL } from "~/lib/history/v3/summary-schema"

/**
 * A single forward schema migration.
 *
 * `up` is async because Umzug's `MigrationFn` returns `Promise<unknown>`;
 * synchronous DDL is fine inside an async body. PREFER `sqlMigration` below over
 * a hand-written `up` for DDL — it wraps the body in a transaction so a
 * mid-body failure rolls back atomically (see the partial-DDL wedge note there).
 */
export interface HistoryMigration {
  name: string
  up: MigrationFn<SqliteDatabase>
}

/**
 * Build a DDL migration whose body runs ATOMICALLY in one transaction.
 *
 * PARTIAL-DDL WEDGE (why this is the preferred constructor): Umzug does NOT wrap
 * `up` in a transaction and records a migration as applied only AFTER `up`
 * resolves. SQLite auto-commits each DDL statement when not inside an explicit
 * transaction, so a multi-statement migration that throws mid-body would leave
 * the earlier statements committed but the migration UNLOGGED — on the next
 * restart it re-runs from the top and dies on the already-applied statement
 * (e.g. "table already exists"), wedging EVERY future start. `applyForwardMigrations`
 * rethrows → refuse-to-start, but that does not undo the partial mutation.
 *
 * Wrapping the body in the driver's `transaction()` makes multi-statement DDL
 * all-or-nothing (SQLite supports transactional DDL), so a failed migration
 * leaves the DB exactly as before and is safely retryable. Use this for any DDL
 * migration. A migration that genuinely cannot run in a transaction (a
 * non-transactional PRAGMA, or a long data backfill) must instead be written
 * individually re-entrant: every statement guarded by `IF NOT EXISTS` or a
 * `PRAGMA table_info` probe (see `migrateEntriesColumns` for the primitive).
 */
export function sqlMigration(name: string, body: (db: SqliteDatabase) => void): HistoryMigration {
  return {
    name,
    up: async ({ context }) => {
      context.transaction(() => body(context))()
    },
  }
}

/**
 * Shipped forward migrations, in apply order. Keep schema-only changes atomic
 * through `sqlMigration`; long data backfills run separately and re-entrantly.
 */
export const MIGRATIONS: Array<HistoryMigration> = [
  sqlMigration("001-operation-summary-projection", (db) => {
    db.exec(SUMMARY_PROJECTION_MIGRATION_SQL)
  }),
  sqlMigration("001-transport-evidence-schema", (db) => {
    const version = db.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get() as { value: string } | undefined
    if (version?.value === "6") return
    if (version?.value !== "5") throw new Error(`[history/v3] transport evidence migration requires schema 5, got ${version?.value ?? "missing"}`)
    db.exec(`CREATE TABLE IF NOT EXISTS v3_transport_evidence (
      digest TEXT PRIMARY KEY,
      encoding TEXT NOT NULL,
      evidence_gz BLOB NOT NULL,
      byte_length INTEGER NOT NULL
    )`)
    const journalColumns = new Set((db.prepare("PRAGMA table_info(v3_journal)").all() as Array<{ name: string }>).map(({ name }) => name))
    if (!journalColumns.has("format_version")) db.exec("ALTER TABLE v3_journal ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1")
    db.exec(`CREATE TABLE IF NOT EXISTS v3_operation_evidence_refs (
      operation_id TEXT NOT NULL REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
      dispatch_index INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      digest TEXT NOT NULL REFERENCES v3_transport_evidence(digest),
      byte_length INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      PRIMARY KEY(operation_id, dispatch_index, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_v3_operation_evidence_refs_digest ON v3_operation_evidence_refs(digest);
    CREATE TABLE IF NOT EXISTS v3_journal_evidence_refs (
      operation_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      dispatch_index INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      digest TEXT NOT NULL REFERENCES v3_transport_evidence(digest),
      byte_length INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      PRIMARY KEY(operation_id, revision, dispatch_index, sequence),
      FOREIGN KEY(operation_id, revision) REFERENCES v3_journal(operation_id, revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_v3_journal_evidence_refs_digest ON v3_journal_evidence_refs(digest);`)
    db.prepare("UPDATE v3_meta SET value='6' WHERE key='schema_version'").run()
  }),
]
