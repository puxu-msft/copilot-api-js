import sqlite from "node:sqlite"

const { DatabaseSync } = sqlite
const db = new DatabaseSync(":memory:")
const prototype = Object.getOwnPropertyNames(DatabaseSync.prototype).sort()
const candidates = [
  "function",
  "scalar",
  "aggregate",
  "setAuthorizer",
  "authorizer",
  "updateHook",
  "update_hook",
  "preupdateHook",
  "preupdate_hook",
  "loadExtension",
  "serialize",
  "deserialize",
  "transaction",
]

db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)")
db.prepare("INSERT INTO t(value) VALUES (?)").run("node-ok")
db.function("twice", (value) => value * 2)
db.aggregate("sumx", { start: 0, step: (accumulator, value) => accumulator + value })
let authorizerCalls = 0
db.setAuthorizer(() => {
  authorizerCalls += 1
  return sqlite.constants.SQLITE_OK
})
const functionRow = db.prepare("SELECT twice(21) AS value").get()
const aggregateRow = db.prepare("SELECT sumx(x) AS value FROM (SELECT 2 AS x UNION ALL SELECT 3)").get()
db.setAuthorizer(null)
const serialized = db.serialize()
const deserialized = new DatabaseSync(":memory:")
deserialized.deserialize(serialized)

const output = {
  runtime: { name: "node", version: process.version },
  backend: "node:sqlite.DatabaseSync",
  moduleOwnProperties: Object.getOwnPropertyNames(sqlite).sort(),
  databaseStaticOwnProperties: Object.getOwnPropertyNames(DatabaseSync).sort(),
  databasePrototypeOwnProperties: prototype,
  databaseInstanceOwnProperties: Object.getOwnPropertyNames(db).sort(),
  candidateMethods: Object.fromEntries(
    candidates.map((name) => [name, { inPrototype: prototype.includes(name), typeofInstance: typeof db[name] }]),
  ),
  smoke: {
    memoryOpen: true,
    ddl: true,
    row: db.prepare("SELECT * FROM t").get(),
    functionRow,
    aggregateRow,
    authorizerCalls,
    serializedBytes: serialized.byteLength,
    deserializeRow: deserialized.prepare("SELECT * FROM t").get(),
  },
}

console.log(JSON.stringify(output, null, 2))
deserialized.close()
db.close()
