import {
  //
  isMainThread,
  parentPort,
} from "node:worker_threads"

import { createDatabase } from "~/lib/sqlite/driver"

import type { HistorySqliteDriver } from "./protocol"

import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "./backend"
import { detectHistorySqliteDriver } from "./protocol"

interface SqliteProbeResult {
  readonly selectedDriver: HistorySqliteDriver
  readonly n: number
}

const directProbe = process.argv.includes("--probe")

if (directProbe) {
  process.stdout.write(`${JSON.stringify(runSqliteProbe())}\n`)
} else if (!isMainThread && parentPort) {
  installHistoryWorkerMessageLoop(parentPort, createHistoryWorkerBackend())
}

/**
 * Runtime capability probe for the packaged-bundle test: proves this entry can be executed
 * directly and that its SQLite driver actually works, without opening a History artifact.
 */
function runSqliteProbe(): SqliteProbeResult {
  const db = createDatabase(":memory:")
  try {
    db.exec("CREATE TABLE history_worker_probe (n INTEGER NOT NULL)")
    db.prepare("INSERT INTO history_worker_probe (n) VALUES (?)").run(7)
    const row = db.prepare("SELECT n FROM history_worker_probe").get() as { n?: number } | null | undefined
    if (row?.n !== 7) throw new Error(`History Worker SQLite probe returned ${String(row?.n)}`)
    return { selectedDriver: detectHistorySqliteDriver(), n: row.n }
  } finally {
    db.close()
  }
}
