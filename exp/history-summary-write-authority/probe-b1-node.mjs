import sqlite from "node:sqlite"

function openConnection() {
  const db = new sqlite.DatabaseSync(":memory:")
  const state = { enabled: 0 }
  db.function("maintenance_mode", () => state.enabled)
  db.exec(`
    CREATE TABLE summaries(id INTEGER PRIMARY KEY, value TEXT);
    CREATE TRIGGER summaries_guard
    BEFORE INSERT ON summaries
    WHEN maintenance_mode() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'controlled maintenance mode required');
    END;
  `)
  return { db, state }
}

const one = openConnection()
const two = openConnection()
const attempts = {}
function capture(name, fn) {
  try {
    attempts[name] = { ok: true, value: fn() }
  } catch (error) {
    attempts[name] = { ok: false, error: String(error) }
  }
}

capture("ordinarySqlCannotSetMode", () => one.db.exec("SELECT maintenance_mode(1)"))
capture("ordinaryWriteRejected", () => one.db.exec("INSERT INTO summaries(value) VALUES ('ordinary')"))
capture("hostToggleConnection1", () => (one.state.enabled = 1))
capture("connection1WriteAllowed", () => one.db.exec("INSERT INTO summaries(value) VALUES ('scoped')"))
capture("connection2StillRejected", () => two.db.exec("INSERT INTO summaries(value) VALUES ('other')"))
capture("hostClearConnection1", () => (one.state.enabled = 0))
capture("connection1RejectedAfterClear", () => one.db.exec("INSERT INTO summaries(value) VALUES ('after')"))

console.log(
  JSON.stringify(
    {
      runtime: process.version,
      hostToggle: "JavaScript closure captured by DatabaseSync.function",
      attempts,
      rows: {
        connection1: one.db.prepare("SELECT * FROM summaries").all(),
        connection2: two.db.prepare("SELECT * FROM summaries").all(),
      },
    },
    null,
    2,
  ),
)

one.db.close()
two.db.close()
