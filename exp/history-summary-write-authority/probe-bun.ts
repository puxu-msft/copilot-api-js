import { Database } from "bun:sqlite"

const db = new Database(":memory:")
const prototype = Object.getOwnPropertyNames(Database.prototype).sort()
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
] as const

db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)")
db.prepare("INSERT INTO t(value) VALUES (?)").run("bun-ok")
const serialized = db.serialize()
const deserialized = Database.deserialize(serialized)

const output = {
  runtime: { name: "bun", version: Bun.version },
  moduleOwnProperties: Object.getOwnPropertyNames(await import("bun:sqlite")).sort(),
  databaseStaticOwnProperties: Object.getOwnPropertyNames(Database).sort(),
  databasePrototypeOwnProperties: prototype,
  databaseInstanceOwnProperties: Object.getOwnPropertyNames(db).sort(),
  candidateMethods: Object.fromEntries(
    candidates.map((name) => [name, { inPrototype: prototype.includes(name), typeofInstance: typeof (db as any)[name] }]),
  ),
  smoke: {
    memoryOpen: true,
    ddl: true,
    row: db.prepare("SELECT * FROM t").get(),
    serializedBytes: serialized.byteLength,
    staticDeserializeRow: deserialized.prepare("SELECT * FROM t").get(),
  },
}

console.log(JSON.stringify(output, null, 2))
deserialized.close()
db.close()
