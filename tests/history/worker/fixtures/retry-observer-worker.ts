import fs from "node:fs"
import {
  //
  parentPort,
  workerData,
} from "node:worker_threads"

import type { Database } from "~/lib/history/sqlite/connection"

import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "~/lib/history/worker/backend"

/**
 * Worker entry that runs the REAL protocol loop and the REAL semantic backend, and only
 * substitutes two injected dependencies: a delay seam that records every backoff wait, and
 * a database wrapper that makes the first N commit transactions fail transiently.
 *
 * The observed waits go to a file rather than a message because `parseWorkerToMainMessage`
 * rejects unknown message types — a diagnostic channel must not widen the production protocol.
 */
interface RetryObserverFixture {
  readonly observedDelaysPath: string
  readonly transientFailures: number
}

if (!parentPort) throw new Error("retry-observer-worker fixture requires a parent port")

const fixture = workerData as RetryObserverFixture
const observedDelays: Array<number> = []
let remainingFailures = fixture.transientFailures
// Schema reconcile and forward migrations also run inside transactions. Arming only after
// initialize keeps the injected fault aimed at the operation commit — a startup failure
// would be reported as `fatal` and would never reach the retry loop this test is about.
let armed = false

const backend = createHistoryWorkerBackend({
  delay: (ms) => {
    observedDelays.push(ms)
    fs.writeFileSync(fixture.observedDelaysPath, JSON.stringify(observedDelays))
    return Promise.resolve()
  },
  openSemanticDatabase: (dbPath) => withTransientCommitFailures(openOwnedHistoryDatabase(dbPath)),
})

installHistoryWorkerMessageLoop(parentPort, {
  ...backend,
  initialize: async (config) => {
    const ready = await backend.initialize(config)
    armed = true
    return ready
  },
})

/** Fail the operation transaction (not the journal insert) so each retry re-runs the whole commit. */
function withTransientCommitFailures(database: Database): Database {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql),
    close: () => database.close(),
    transaction: <T>(fn: () => T) => {
      const inner = database.transaction(fn)
      return () => {
        if (armed && remainingFailures > 0) {
          remainingFailures--
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        }
        return inner()
      }
    },
  }
}
