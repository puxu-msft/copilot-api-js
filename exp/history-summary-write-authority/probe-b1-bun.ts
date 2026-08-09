import { dlopen, FFIType } from "bun:ffi"
import { Database } from "bun:sqlite"

const root = "/home/xp/src/copilot-api-js/.worktree/agent-a0b5eee4b161ab9ab/exp/history-summary-write-authority"
const extension = `${root}/maintenance_mode_extension.local`
const native = dlopen(extension, {
  maintenance_mode_set: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
})

const db1 = new Database(":memory:")
const db2 = new Database(":memory:")
db1.loadExtension(extension, "sqlite3_maintenancemode_init")
db2.loadExtension(extension, "sqlite3_maintenancemode_init")
for (const db of [db1, db2]) {
  db.exec(`
    CREATE TABLE summaries(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TRIGGER summaries_guard
    BEFORE INSERT ON summaries
    WHEN maintenance_mode() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'controlled maintenance mode required');
    END;
  `)
}

const id1 = db1.query("SELECT maintenance_connection_id() AS id").get()!.id as number
const id2 = db2.query("SELECT maintenance_connection_id() AS id").get()!.id as number
const attempts: Record<string, unknown> = {}
function capture(name: string, fn: () => unknown) {
  try {
    attempts[name] = { ok: true, value: fn() }
  } catch (error) {
    attempts[name] = { ok: false, error: String(error) }
  }
}

capture("ordinarySqlCannotSetMode", () => db1.exec("SELECT maintenance_mode(1)"))
capture("ordinaryWriteRejected", () => db1.exec("INSERT INTO summaries(value) VALUES ('ordinary')"))
capture("hostToggleConnection1", () => native.symbols.maintenance_mode_set(BigInt(id1), 1))
capture("connection1WriteAllowed", () => db1.exec("INSERT INTO summaries(value) VALUES ('scoped')"))
capture("connection2StillRejected", () => db2.exec("INSERT INTO summaries(value) VALUES ('other')"))
capture("hostClearConnection1", () => native.symbols.maintenance_mode_set(BigInt(id1), 0))
capture("connection1RejectedAfterClear", () => db1.exec("INSERT INTO summaries(value) VALUES ('after')"))

console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      extension,
      hostToggle: "bun:ffi dlopen exported maintenance_mode_set(connection_id, enabled)",
      connectionIds: [id1, id2],
      attempts,
      rows: {
        connection1: db1.query("SELECT * FROM summaries").all(),
        connection2: db2.query("SELECT * FROM summaries").all(),
      },
    },
    null,
    2,
  ),
)

db1.close()
db2.close()
native.close()
