// Probe: does adding `usage_normalized INTEGER NOT NULL DEFAULT 0` via ALTER
// backfill an EXISTING row to 0 without a table rewrite? (mirrors migrateEntriesColumns)
import { Database } from "bun:sqlite"

const db = new Database(":memory:")
// Old schema WITHOUT usage_normalized, one pre-existing row.
db.exec(`CREATE TABLE entries_v2 (id TEXT PRIMARY KEY, input_tokens INTEGER, cache_read INTEGER)`)
db.exec(`INSERT INTO entries_v2 (id, input_tokens, cache_read) VALUES ('old1', 1000, 400)`)

// The exact ALTER migrateEntriesColumns will run.
db.exec(`ALTER TABLE entries_v2 ADD COLUMN usage_normalized INTEGER NOT NULL DEFAULT 0`)

const cols = (db.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>).map((c) => c.name)
const oldRow = db.prepare("SELECT id, input_tokens, cache_read, usage_normalized FROM entries_v2 WHERE id='old1'").get()
console.log("columns:", cols.join(","))
console.log("old row:", JSON.stringify(oldRow))
console.log("PASS:", cols.includes("usage_normalized") && (oldRow as any).usage_normalized === 0 && (oldRow as any).input_tokens === 1000)
db.close()
