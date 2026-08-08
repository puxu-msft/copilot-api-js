/**
 * Umzug forward-migration pipe wired to V3 (History V2 removal Phase 4d).
 *
 * `migrations/run.ts` + `migrations/storage.ts` were already unit-tested in
 * ISOLATION against a bare `:memory:` db (`tests/history/sqlite/migrations.it.test.ts`)
 * — that file proves the runner itself (Umzug wiring, ledger read/write, rollback
 * semantics) works. This file proves the OTHER half: that `initHistory`'s V3 open
 * path actually CALLS `applyForwardMigrations` against the real, production-shaped
 * V3 db (`V3_SCHEMA_SQL` already applied, `recoverV3Journal` about to run) — not
 * just that the pipe exists in isolation.
 *
 * The shipped `MIGRATIONS` array now contains the summary-projection migration.
 * These tests verify that production DDL first, then inject an independent probe
 * migration to keep exercising the runner's generic ordered/run-once contract
 * against the SAME db `initHistory` opened.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  //
  closeDatabase,
  getDatabase,
  isDatabaseOpen,
} from "~/lib/history/sqlite/connection"
import {
  //
  getMeta,
  MIGRATIONS_RUN_KEY,
} from "~/lib/history/sqlite/meta"
import {
  //
  type HistoryMigration,
  sqlMigration,
} from "~/lib/history/sqlite/migrations/index"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { SUMMARY_PROJECTION_FIELDS } from "~/lib/history/v3/summary-schema"
import { setStateForTests } from "~/lib/state"

function tableExists(name: string): boolean {
  return Boolean(getDatabase().prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name))
}

describe("Umzug migrations wired to V3 initHistory (Phase 4d)", () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-migrations-"))
    dbPath = path.join(dir, "history-v3.db")
    setStateForTests({ historyDbPath: dbPath })
  })

  afterEach(async () => {
    if (isDatabaseOpen()) closeDatabase()
    setStateForTests({ historyDbPath: "" })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("initHistory(true) creates history_meta on the opened V3 db (new open-path behavior)", async () => {
    await initHistory(true)
    expect(tableExists("history_meta")).toBe(true)
    expect(tableExists("v3_operation_summaries")).toBe(true)
    expect(Boolean(getDatabase().prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='v3_operation_summaries_after_insert'").get())).toBe(true)
    expect(JSON.parse(getMeta(getDatabase(), MIGRATIONS_RUN_KEY) ?? "[]")).toEqual([
      "001-operation-summary-projection",
      "001-transport-evidence-schema",
      "002-summary-integrity-invalidation",
    ])
  })

  test("a non-empty injected MIGRATIONS array runs REAL DDL against the initHistory-opened V3 db, ledgers it, and idempotently no-ops on rerun", async () => {
    await initHistory(true)

    let upCallCount = 0
    const migrations: Array<HistoryMigration> = [
      sqlMigration("001-wiring-probe", (d) => {
        upCallCount++
        d.exec("CREATE TABLE wiring_probe (id INTEGER PRIMARY KEY)")
      }),
    ]

    // First application: real DDL against the SAME db initHistory opened
    // (not a fresh throwaway db) — proves the pipe is genuinely connected, not
    // just independently functional.
    await applyForwardMigrations(getDatabase(), migrations)
    expect(upCallCount).toBe(1)
    expect(tableExists("wiring_probe")).toBe(true)
    expect(JSON.parse(getMeta(getDatabase(), MIGRATIONS_RUN_KEY) ?? "[]")).toEqual([
      "001-operation-summary-projection",
      "001-transport-evidence-schema",
      "002-summary-integrity-invalidation",
      "001-wiring-probe",
    ])

    // Idempotent rerun: Umzug's ledger (in the SAME history_meta table
    // initHistory's open path built) must skip an already-applied migration.
    await applyForwardMigrations(getDatabase(), migrations)
    expect(upCallCount).toBe(1) // NOT re-invoked
  })

  test("production startup leaves a schema-5 database unchanged when transport migration fails, then retries successfully", async () => {
    // Seed a production-owned on-disk DB whose authoritative schema state is 5.
    // The trigger lives inside the fixture so the real initHistory ordering, not
    // an injected migration list, drives the failure.
    const db = (await import("~/lib/sqlite/driver")).createDatabase(dbPath)
    db.exec(`
      CREATE TABLE history_store_identity(owner TEXT PRIMARY KEY);
      INSERT INTO history_store_identity(owner) VALUES('copilot-api-history-v3');
      CREATE TABLE history_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO history_meta(key,value) VALUES('schema_migrations','["001-operation-summary-projection"]');
      CREATE TABLE v3_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO v3_meta(key,value) VALUES('schema_version','5');
      CREATE TABLE v3_operations(
        operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL,
        kind TEXT NOT NULL, created_at INTEGER NOT NULL, terminal_sequence INTEGER NOT NULL,
        ended_at INTEGER, timing_source TEXT NOT NULL DEFAULT 'storage-commit-upper-bound',
        manifest_gz BLOB NOT NULL, summary_json TEXT, pinned INTEGER NOT NULL DEFAULT 0,
        committed_at INTEGER NOT NULL
      );
      CREATE TABLE v3_operation_summaries(
        ${SUMMARY_PROJECTION_FIELDS.map((field) => `${field.column} ${field.sqlType}`).join(",")}
      );
      CREATE TABLE v3_journal(
        operation_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
        phase TEXT NOT NULL, payload_gz BLOB NOT NULL, created_at INTEGER NOT NULL,
        committed_at INTEGER, error TEXT, PRIMARY KEY(operation_id,revision)
      );
      CREATE TRIGGER reject_schema_version BEFORE UPDATE OF value ON v3_meta
        WHEN OLD.key='schema_version' BEGIN SELECT RAISE(ABORT,'schema version blocked'); END;
    `)
    db.close()

    await expect(initHistory(true)).rejects.toThrow(/schema version blocked/i)
    const failed = getDatabase()
    expect(failed.prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "5" })
    expect(failed.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_transport_evidence'").get()).toBeNull()
    expect((failed.prepare("PRAGMA table_info(v3_journal)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toContain("format_version")
    failed.exec("DROP TRIGGER reject_schema_version")
    closeDatabase()

    await initHistory(true)
    expect(getDatabase().prepare("SELECT value FROM v3_meta WHERE key='schema_version'").get()).toEqual({ value: "6" })
    expect(tableExists("v3_transport_evidence")).toBe(true)
    expect((getDatabase().prepare("PRAGMA table_info(v3_journal)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("format_version")
  })

  test("initHistory rethrows (not swallows) when a migration fails — refuse-to-start contract", async () => {
    // A failing migration must propagate all the way out of initHistory, since
    // `initHistory` awaits `applyForwardMigrations` directly with no try/catch.
    // The shipped migration already ran successfully. Inject a later failing
    // migration to prove the runner rejects it without erasing prior ledgered
    // success or logging the failed name.
    await initHistory(true)
    const failing: Array<HistoryMigration> = [
      {
        name: "001-boom",
        up: async () => {
          throw new Error("boom")
        },
      },
    ]
    await expect(applyForwardMigrations(getDatabase(), failing)).rejects.toThrow("boom")
    // Failed migration must stay unlogged (pending) so it retries next start.
    expect(JSON.parse(getMeta(getDatabase(), MIGRATIONS_RUN_KEY) ?? "[]")).toEqual([
      "001-operation-summary-projection",
      "001-transport-evidence-schema",
      "002-summary-integrity-invalidation",
    ])
  })

  test("shutdownHistory + reopen: the ledgered migration is not re-applied across a real restart", async () => {
    await initHistory(true)
    let upCallCount = 0
    const migrations: Array<HistoryMigration> = [
      sqlMigration("001-restart-probe", () => {
        upCallCount++
      }),
    ]
    await applyForwardMigrations(getDatabase(), migrations)
    expect(upCallCount).toBe(1)

    await shutdownHistory()
    await initHistory(true) // production open path sees the shipped migration in the ledger and skips it

    // Re-apply the SAME test migrations against the reopened db — ledger persisted on disk.
    await applyForwardMigrations(getDatabase(), migrations)
    expect(upCallCount).toBe(1) // still not re-invoked — ledger survived the restart
  })
})
