import { Database } from "bun:sqlite"
import { Umzug } from "umzug"

const db = new Database(":memory:")
db.exec("CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY, value TEXT)")

// 自定义 storage 落到 history_meta(单一账本) —— UmzugStorage 三方法
const MIGRATED_KEY = "umzug_migrated"
const storage = {
  async logMigration({ name }: { name: string }) {
    const row = db.query("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY) as { value: string } | null
    const list: string[] = row ? JSON.parse(row.value) : []
    list.push(name)
    db.query("INSERT OR REPLACE INTO history_meta(key,value) VALUES(?,?)").run(MIGRATED_KEY, JSON.stringify(list))
  },
  async unlogMigration({ name }: { name: string }) {
    const row = db.query("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY) as { value: string } | null
    const list: string[] = row ? JSON.parse(row.value) : []
    db.query("INSERT OR REPLACE INTO history_meta(key,value) VALUES(?,?)").run(MIGRATED_KEY, JSON.stringify(list.filter((n) => n !== name)))
  },
  async executed() {
    const row = db.query("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY) as { value: string } | null
    return row ? JSON.parse(row.value) : []
  },
}

const umzug = new Umzug({
  migrations: [
    { name: "000-baseline-idempotent", up: ({ context }: any) => { context.exec("CREATE TABLE IF NOT EXISTS entries(id TEXT)") } },
    { name: "001-add-col", up: ({ context }: any) => { context.exec("ALTER TABLE entries ADD COLUMN prev_id TEXT") } },
  ],
  context: db,
  storage,
  logger: undefined,
})

const ran1 = await umzug.up()
console.log("run1 applied:", ran1.map((m) => m.name))
const ran2 = await umzug.up()           // 第二次:全已执行 → 应空(run-once)
console.log("run2 applied:", ran2.map((m) => m.name), "(应为空=run-once)")
console.log("pending now:", (await umzug.pending()).map((m) => m.name), "(应为空)")
console.log("ledger in history_meta:", db.query("SELECT value FROM history_meta WHERE key=?").get(MIGRATED_KEY))
// 验 schema 真的变了
const cols = db.query("PRAGMA table_info(entries)").all() as Array<{ name: string }>
console.log("entries 列:", cols.map((c) => c.name), "(应含 prev_id)")
