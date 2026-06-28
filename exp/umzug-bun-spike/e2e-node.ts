// P3 node:sqlite end-to-end leg — drives the REAL production modules
// (createDatabase → node:sqlite DatabaseSync + manual tx wrapper, the real
// HistoryMetaStorage, the real applyForwardMigrations) under Node, NOT a
// hand-rolled storage like the P0 spike. Run: node e2e-node.ts
//
// Empirical-verification: proves the production code path works on node:sqlite,
// not just bun:sqlite (the suite only runs under `bun test`).
import { Umzug } from "umzug"

import { createDatabase } from "../../src/lib/history/sqlite/driver.ts"
import { getMeta, MIGRATIONS_RUN_KEY } from "../../src/lib/history/sqlite/meta.ts"
import { type HistoryMigration, sqlMigration } from "../../src/lib/history/sqlite/migrations/index.ts"
import { applyForwardMigrations } from "../../src/lib/history/sqlite/migrations/run.ts"
import { HistoryMetaStorage } from "../../src/lib/history/sqlite/migrations/storage.ts"

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  console.log(`  ok: ${msg}`)
}

const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node"
console.log(`runtime = ${runtime} (expect node)`)

// ── 1) real applyForwardMigrations on a bare DB (empty MIGRATIONS, no floor) ──
{
  const db = createDatabase(":memory:")
  await applyForwardMigrations(db) // chicken-egg guard must make this self-sufficient
  const storage = new HistoryMetaStorage(db)
  assert(JSON.stringify(await storage.executed()) === "[]", "empty MIGRATIONS no-op, executed()=[]")
  db.close()
}

// ── 2) real HistoryMetaStorage + Umzug, ordered + run-once + ledger ──
{
  const db = createDatabase(":memory:")
  const applied: Array<string> = []
  const migrations: Array<HistoryMigration> = [
    { name: "001-create-t", up: async ({ context }) => { context.exec("CREATE TABLE t (x TEXT)"); applied.push("001") } },
    { name: "002-add-col", up: async ({ context }) => { context.exec("ALTER TABLE t ADD COLUMN y TEXT"); applied.push("002") } },
  ]
  const run = async (): Promise<Array<string>> => {
    const umzug = new Umzug({ migrations, context: db, storage: new HistoryMetaStorage(db), logger: undefined })
    return (await umzug.up()).map((m) => m.name)
  }
  assert(JSON.stringify(await run()) === JSON.stringify(["001-create-t", "002-add-col"]), "ordered apply")
  assert(JSON.stringify(applied) === JSON.stringify(["001", "002"]), "up bodies ran in order")
  const cols = (db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>).map((c) => c.name)
  assert(JSON.stringify(cols) === JSON.stringify(["x", "y"]), "schema actually changed (x,y)")
  assert(JSON.stringify(await run()) === "[]", "run-once: second up applies nothing")
  assert(JSON.stringify(applied) === JSON.stringify(["001", "002"]), "up bodies NOT re-run")
  assert(getMeta(db, MIGRATIONS_RUN_KEY) === JSON.stringify(["001-create-t", "002-add-col"]), "ledger persisted in history_meta")
  db.close()
}

// ── 3) sqlMigration rollback under node:sqlite's MANUAL BEGIN/COMMIT/ROLLBACK ──
// (runtime-divergent from bun's native .transaction — must verify the node leg)
{
  const db = createDatabase(":memory:")
  const bad: Array<HistoryMigration> = [
    sqlMigration("001-partial", (d) => {
      d.exec("CREATE TABLE a (x TEXT)")
      throw new Error("mid-body")
    }),
  ]
  let threw = false
  try {
    await applyForwardMigrations(db, bad)
  } catch {
    threw = true
  }
  assert(threw, "sqlMigration mid-body throw rethrows")
  const hasA = Boolean(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='a'").get())
  assert(!hasA, "ROLLBACK undid the partial CREATE (retryable, not wedged)")
  assert(JSON.stringify(await new HistoryMetaStorage(db).executed()) === "[]", "failed migration not logged")
  db.close()
}

console.log("node:sqlite end-to-end: PASS")