import fs from "node:fs"
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
 * Worker entry that kills its own thread at one precise point of the persistence sequence.
 *
 * `process.exit()` inside a Worker terminates only that thread (measured on Bun 1.3.14: the
 * main thread observes `exit:<code>` and no `error`), which is the only mechanism that can
 * stop the Worker *inside* an open SQLite transaction. Throwing would merely roll the
 * transaction back, collapsing three of these four windows into the same case.
 *
 * The crash fires once: a marker file survives the thread, so the replacement Worker — a
 * fresh thread with fresh module state — completes the replay instead of crash-looping.
 */
type CrashWindow = "before-journal" | "after-journal" | "mid-transaction" | "after-commit"

interface CrashWindowFixture {
  readonly window: CrashWindow
  readonly markerPath: string
}

if (!parentPort) throw new Error("crash-window-worker fixture requires a parent port")

const fixture = workerData as CrashWindowFixture
let armed = false

const backend = createHistoryWorkerBackend({
  openSemanticDatabase: (dbPath) => withCrashWindow(openOwnedHistoryDatabase(dbPath)),
})

installHistoryWorkerMessageLoop(parentPort, {
  ...backend,
  initialize: async (config) => {
    const ready = await backend.initialize(config)
    // Startup reconcile/migration/recovery also touch these statements; arming afterwards
    // keeps every window aimed at the persistence sequence it names.
    armed = true
    return ready
  },
  persist: async (envelope) => {
    if (fixture.window === "before-journal") crashOnce()
    return await backend.persist(envelope)
  },
})

function withCrashWindow(database: Database): Database {
  return {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    prepare: (sql) => {
      const statement = database.prepare(sql)
      if (fixture.window === "after-journal" && sql.includes("INSERT OR REPLACE INTO v3_journal")) return crashAfterRun(statement)
      // Inside the operation transaction: the row is written, then the thread dies before
      // COMMIT, so SQLite rolls it back and only the journal row survives.
      if (fixture.window === "mid-transaction" && sql.includes("INSERT INTO v3_operations(")) return crashAfterRun(statement)
      return statement
    },
    transaction: <T>(fn: () => T) => {
      const inner = database.transaction(fn)
      return () => {
        const result = inner()
        // The transaction function returns only after COMMIT, so this is the
        // committed-but-unacknowledged window.
        if (fixture.window === "after-commit") crashOnce()
        return result
      }
    },
  }
}

function crashAfterRun(statement: SqliteStatement): SqliteStatement {
  return {
    all: (...params) => statement.all(...params),
    get: (...params) => statement.get(...params),
    run: (...params) => {
      const result = statement.run(...params)
      crashOnce()
      return result
    },
  }
}

function crashOnce(): void {
  if (!armed || fs.existsSync(fixture.markerPath)) return
  fs.writeFileSync(fixture.markerPath, fixture.window)
  process.exit(17)
}
