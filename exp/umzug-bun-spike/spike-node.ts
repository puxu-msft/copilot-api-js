// node:sqlite leg of the Umzug double-runtime gate (run with: node spike-node.ts).
// Mirrors spike.ts (bun:sqlite) but on node:sqlite DatabaseSync (Node ≥22.5).
//
// Empirical-verification note: we deliberately do NOT pre-create history_meta
// (the bun spike's line-5 pre-create masked the chicken-egg bug). We first
// REPRODUCE the chicken-egg ("no such table: history_meta") with an unguarded
// storage, then prove the table-missing guard resolves it — the exact guard P1
// bakes into HistoryMetaStorage.
import { DatabaseSync } from "node:sqlite"
import { Umzug } from "umzug"

const MIGRATED_KEY = "schema_migrations"

interface MetaDb {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: Array<unknown>): unknown
    run(...params: Array<unknown>): unknown
    all(...params: Array<unknown>): Array<unknown>
  }
}

function readLedger(db: MetaDb, guardTableMissing: boolean): Array<string> {
  if (guardTableMissing) {
    const t = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='history_meta'").get()
    if (!t) return []
  }
  const row = db.prepare("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY) as { value: string } | null
  return row ? (JSON.parse(row.value) as Array<string>) : []
}

function makeStorage(db: MetaDb, opts: { createTableOnConstruct: boolean; guardExecuted: boolean }) {
  // The P1 fix: create history_meta on construct so the runner is self-sufficient
  // on a bare DB, AND guard executed() so a never-written ledger reads as [].
  if (opts.createTableOnConstruct) db.exec("CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY, value TEXT)")
  return {
    async logMigration({ name }: { name: string }) {
      const list = readLedger(db, opts.guardExecuted)
      list.push(name)
      db.prepare("INSERT INTO history_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MIGRATED_KEY, JSON.stringify(list))
    },
    async unlogMigration({ name }: { name: string }) {
      const list = readLedger(db, opts.guardExecuted).filter((n) => n !== name)
      db.prepare("INSERT INTO history_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MIGRATED_KEY, JSON.stringify(list))
    },
    async executed() {
      return readLedger(db, opts.guardExecuted)
    },
  }
}

const MIGRATIONS = [
  { name: "000-baseline-idempotent", up: ({ context }: { context: MetaDb }) => context.exec("CREATE TABLE IF NOT EXISTS entries(id TEXT)") },
  { name: "001-add-col", up: ({ context }: { context: MetaDb }) => context.exec("ALTER TABLE entries ADD COLUMN prev_id TEXT") },
]

async function run() {
  // ── 1) REPRODUCE chicken-egg: bare DB, unguarded storage, no pre-create ──
  {
    const db = new DatabaseSync(":memory:") as unknown as MetaDb
    const umzug = new Umzug({
      migrations: MIGRATIONS,
      context: db,
      storage: makeStorage(db, { createTableOnConstruct: false, guardExecuted: false }),
      logger: undefined,
    })
    try {
      await umzug.up()
      console.log("UNEXPECTED: unguarded up() did NOT throw (chicken-egg not reproduced)")
    } catch (err) {
      console.log("REPRODUCED chicken-egg (expected):", err instanceof Error ? err.message : String(err))
    }
  }

  // ── 2) GUARD resolves it: create-on-construct + executed() table guard ──
  {
    const db = new DatabaseSync(":memory:") as unknown as MetaDb
    const umzug = new Umzug({
      migrations: MIGRATIONS,
      context: db,
      storage: makeStorage(db, { createTableOnConstruct: true, guardExecuted: true }),
      logger: undefined,
    })
    const ran1 = await umzug.up()
    console.log("guarded run1 applied:", ran1.map((m) => m.name))
    const ran2 = await umzug.up() // already executed → empty (run-once)
    console.log("guarded run2 applied:", ran2.map((m) => m.name), "(应为空=run-once)")
    console.log("pending now:", (await umzug.pending()).map((m) => m.name), "(应为空)")
    console.log("ledger in history_meta:", db.prepare("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY))
    const cols = db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>
    console.log("entries 列:", cols.map((c) => c.name), "(应含 prev_id)")
  }
}

await run()
