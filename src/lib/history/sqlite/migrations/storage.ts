/**
 * Umzug storage backed by the `history_meta` key/value table — the same single
 * ledger that already holds the search-index flags. Keeping schema-migration
 * provenance here (rather than a separate `migrations` table) means one source
 * of truth for "what state is this DB in".
 *
 * The applied-migration names live as a JSON `string[]` under MIGRATIONS_RUN_KEY.
 */

import type { UmzugStorage } from "umzug"

import type { SqliteDatabase } from "~/lib/sqlite/driver"

import {
  //
  getMeta,
  MIGRATIONS_RUN_KEY,
  setMeta,
} from "../meta"
import { HISTORY_META_DDL } from "../schema"

/**
 * history_meta-backed Umzug ledger.
 *
 * Chicken-and-egg guard: Umzug calls `storage.executed()` BEFORE running any
 * migration, but on a bare DB (no openDatabase floor) `history_meta` may not
 * exist yet. The constructor creates it (`CREATE TABLE IF NOT EXISTS`) so the
 * runner is self-sufficient regardless of open order; `executed()` additionally
 * tolerates a still-missing table by returning `[]`. In production the floor
 * (openDatabase → SCHEMA_SQL) has already created `history_meta`, so the
 * constructor is a no-op there — the guard exists so the migrations module stays
 * testable in isolation and never depends on the open sequence.
 */
export class HistoryMetaStorage implements UmzugStorage<SqliteDatabase> {
  private readonly db: SqliteDatabase

  constructor(db: SqliteDatabase) {
    this.db = db
    // Single-sourced with SCHEMA_SQL (the floor) so the bare-DB guard and the
    // floor can never define history_meta differently.
    this.db.exec(HISTORY_META_DDL)
  }

  /** Applied migration names (empty when the table or key is absent). */
  async executed(): Promise<Array<string>> {
    return this.readLedger()
  }

  /** Mark `name` as applied (idempotent — never duplicates). */
  async logMigration({ name }: { name: string }): Promise<void> {
    const list = this.readLedger()
    if (!list.includes(name)) list.push(name)
    setMeta(this.db, MIGRATIONS_RUN_KEY, JSON.stringify(list))
  }

  /** Mark `name` as not-applied (used by `down`, which this runner never calls). */
  async unlogMigration({ name }: { name: string }): Promise<void> {
    const list = this.readLedger().filter((n) => n !== name)
    setMeta(this.db, MIGRATIONS_RUN_KEY, JSON.stringify(list))
  }

  private readLedger(): Array<string> {
    // Belt-and-suspenders table guard: the constructor normally creates the
    // table, but a raw SELECT on a (somehow) absent history_meta would throw
    // "no such table". `.get()` returns null on bun:sqlite / undefined on
    // node:sqlite when no row matches — `!row` covers both.
    const hasTable = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'history_meta'").get()
    if (!hasTable) return []

    const raw = getMeta(this.db, MIGRATIONS_RUN_KEY)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : []
    } catch {
      // A corrupt ledger value is treated as "nothing applied" rather than
      // crashing startup; the migrations re-run (their `up` must be idempotent).
      return []
    }
  }
}
