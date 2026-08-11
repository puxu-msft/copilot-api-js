import {
  //
  parentPort,
  workerData,
} from "node:worker_threads"

import type { Database } from "~/lib/history/sqlite/connection"
import type { SqliteStatement } from "~/lib/sqlite/driver"

import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "~/lib/history/worker/backend"

/**
 * Worker entry whose operation transaction always fails PERMANENTLY.
 *
 * `failed` is the outcome the whole durability contract hangs on — spec §8.2 step 6 turns a
 * single `failed` into a failed shutdown and exit 1 — and it is unreachable from the happy
 * path, so without an injected failure the tests cannot tell `persist()` apart from a
 * function that returns `"persisted"` unconditionally.
 *
 * The message deliberately avoids BUSY/LOCKED/IOERR: persist-guard would classify those as
 * transient and `runWithTransientRetry` would retry, which is a different code path with a
 * different meaning. This is the "disk is telling you no, and will keep telling you no" case.
 */
interface PermanentFailureFixture {
  /** Substring of the statement whose `run` should throw; defaults to the operation insert. */
  readonly failOnSql?: string
}

if (!parentPort) throw new Error("permanent-failure-worker fixture requires a parent port")

const fixture = (workerData ?? {}) as PermanentFailureFixture
const failOnSql = fixture.failOnSql ?? "INSERT INTO v3_operations("
let armed = false

const backend = createHistoryWorkerBackend({
  openSemanticDatabase: (dbPath) => withPermanentFailure(openOwnedHistoryDatabase(dbPath)),
})

installHistoryWorkerMessageLoop(parentPort, {
  ...backend,
  initialize: async (config) => {
    const ready = await backend.initialize(config)
    // Startup reconcile/migration/recovery run the same statements; arming afterwards keeps
    // the injected failure aimed at persistence rather than at the startup gate.
    armed = true
    return ready
  },
})

function withPermanentFailure(database: Database): Database {
  return {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    transaction: <T>(fn: () => T) => database.transaction(fn),
    prepare: (sql) => {
      const statement = database.prepare(sql)
      if (!sql.includes(failOnSql)) return statement
      return failingRun(statement)
    },
  }
}

function failingRun(statement: SqliteStatement): SqliteStatement {
  return {
    all: (...params) => statement.all(...params),
    get: (...params) => statement.get(...params),
    run: (...params) => {
      if (armed) throw new Error("SQLITE_CONSTRAINT: injected permanent write failure")
      return statement.run(...params)
    },
  }
}
