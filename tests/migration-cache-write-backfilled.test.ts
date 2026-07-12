import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { SCHEMA_SQL } from "~/lib/history/sqlite/schema"

test("cache_write_backfilled column exists on a fresh schema, defaults to 0", () => {
  const db = new Database(":memory:")
  db.exec(SCHEMA_SQL)
  const cols = db.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string; dflt_value: unknown }>
  const col = cols.find((c) => c.name === "cache_write_backfilled")
  expect(col).toBeDefined()
  // NOT NULL DEFAULT 0 → a row inserted without it lands 0.
  db.exec("INSERT INTO entries_v2 (id, started_at, endpoint, status, blob_gz) VALUES ('x', 1, 'openai-chat-completions', 'completed', x'00')")
  const row = db.prepare("SELECT cache_write_backfilled AS b FROM entries_v2 WHERE id = 'x'").get() as { b: number }
  expect(row.b).toBe(0)
  db.close()
})
