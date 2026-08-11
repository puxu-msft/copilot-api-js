import { createDatabase } from "../../packages/foundation/src/sqlite/driver.ts"

const db = createDatabase(":memory:")
db.exec("CREATE TABLE t(x TEXT)")
db.prepare("INSERT INTO t VALUES (?)").run("node-driver-ok")
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      importedModule: "../../packages/foundation/src/sqlite/driver.ts",
      memoryOpen: true,
      ddl: true,
      row: db.prepare("SELECT x FROM t").get(),
    },
    null,
    2,
  ),
)
db.close()
