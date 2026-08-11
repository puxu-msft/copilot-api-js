import fs from "node:fs"
import {
  //
  parentPort,
  workerData,
} from "node:worker_threads"

import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "~/lib/history/worker/backend"

/**
 * Worker entry whose FIRST N startups fail with a transient SQLite condition.
 *
 * Spec §7.1 routes retryable startup errors through the automatic restart, not through
 * irreversible `terminal-failed`. The count lives in a file because each failed attempt
 * kills the thread, taking module state with it — the replacement is a fresh thread and
 * would otherwise fail identically forever.
 */
interface RetryableStartupFixture {
  readonly attemptsPath: string
  readonly failures: number
}

if (!parentPort) throw new Error("retryable-startup-worker fixture requires a parent port")

const fixture = workerData as RetryableStartupFixture
const backend = createHistoryWorkerBackend()

installHistoryWorkerMessageLoop(parentPort, {
  ...backend,
  initialize: async (config) => {
    const attempts = readAttempts() + 1
    fs.writeFileSync(fixture.attemptsPath, String(attempts))
    if (attempts <= fixture.failures) {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
    }
    return await backend.initialize(config)
  },
})

function readAttempts(): number {
  if (!fs.existsSync(fixture.attemptsPath)) return 0
  return Number.parseInt(fs.readFileSync(fixture.attemptsPath, "utf8"), 10) || 0
}
