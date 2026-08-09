/**
 * Batch 2b Step 2b.4 — the central claim of the cutover: History's synchronous work no longer freezes the main thread.
 *
 * Every other test in this batch would still pass if the "cutover" had moved the connection object into the Worker while leaving some compression / prepare / commit call wired to the main thread: rows land, outcomes arrive, the protocol is honoured — and the proxy stalls on every request anyway. Only a timing observation separates those two worlds.
 *
 * The pair is deliberately symmetric. Both arms drive the SAME backend through the SAME message loop with the SAME injected block (`withSynchronousBlock`); the only difference is whether a thread boundary sits in between. The in-process arm is the negative control that proves the probe can see a freeze at all — without it, "the main thread stayed responsive" is indistinguishable from "the metronome cannot detect anything".
 *
 * Why a metronome rather than a `/health/liveness` request: that route is a synchronous JSON handler (`src/server.ts`, `c.json({ status: "alive" })`) with no dependencies, so it is delayed by exactly the stall measured here — an HTTP round trip would observe the same quantity through more machinery and with coarser resolution. The measurement below is of the resource both share.
 *
 * Measured at the commit that introduced this file: worker arm 30ms, in-process arm 1053ms (two 500ms blocks with no tick in between). The thresholds are set far inside that gap on purpose; re-measure rather than relax them if this ever runs close.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { TempSemanticDb } from "./fixtures/semantic-envelope"

import type { HistoryPersistenceOutcome } from "~/lib/history/worker/protocol"

import { HistoryPersistenceRuntimeImpl } from "~/lib/history/worker/runtime"

import { withSynchronousBlock } from "./fixtures/blocking-backend"
import { createInProcessHistoryPersistenceRuntime } from "./fixtures/in-process-runtime"
import {
  //
  buildEnvelope,
  buildStartConfig,
  buildTerminalRecord,
  createTempSemanticDb,
} from "./fixtures/semantic-envelope"

const blockingWorkerUrl = new URL("./fixtures/blocking-backend-worker.ts", import.meta.url)

/** Long enough that a frozen loop is unmistakable, short enough to run twice per arm. */
const BLOCK_MS = 500
/** Metronome period. Well under the block, so a freeze swallows many ticks rather than one. */
const TICK_MS = 20

const openTempDbs: Array<TempSemanticDb> = []
const openRuntimes: Array<HistoryPersistenceRuntimeImpl> = []

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) await runtime.shutdown()
  for (const temp of openTempDbs.splice(0)) temp.cleanup()
})

function tempDb(prefix: string): TempSemanticDb {
  const temp = createTempSemanticDb(prefix)
  openTempDbs.push(temp)
  return temp
}

function track<T extends HistoryPersistenceRuntimeImpl>(runtime: T): T {
  openRuntimes.push(runtime)
  return runtime
}

/**
 * Longest stretch during which the main thread could not run a timer callback.
 *
 * This is the property a user feels: a request handler, a health probe and this metronome are all just callbacks waiting for the same loop, so whatever gap this sees is the gap they would see.
 */
async function longestMainThreadStall(drive: () => Promise<void>): Promise<number> {
  const ticks: Array<number> = [Date.now()]
  const metronome = setInterval(() => ticks.push(Date.now()), TICK_MS)
  try {
    await drive()
  } finally {
    clearInterval(metronome)
  }
  ticks.push(Date.now())

  let longest = 0
  for (let i = 1; i < ticks.length; i++) longest = Math.max(longest, ticks[i] - ticks[i - 1])
  return longest
}

/** Start the runtime and persist one real terminal operation — initialize and persist are exactly the two calls the fixture blocks. */
function driveOneOperation(runtime: HistoryPersistenceRuntimeImpl, dbPath: string, operationId: string): () => Promise<void> {
  return async () => {
    await runtime.start(buildStartConfig(dbPath))
    const envelope = buildEnvelope(buildTerminalRecord(operationId))
    const outcome = await new Promise<HistoryPersistenceOutcome>((resolve) => {
      runtime.enqueue(envelope, resolve)
    })
    // A freeze measurement over work that silently failed would be measuring nothing.
    expect(outcome).toBe("persisted")
  }
}

describe("History persistence does not block the main thread", () => {
  test("a Worker blocking for half a second leaves the main thread running, while the same block in-process freezes it", async () => {
    const workerDb = tempDb("history-isolation-worker-")
    const workerRuntime = track(new HistoryPersistenceRuntimeImpl({ workerUrl: blockingWorkerUrl, workerData: { blockMs: BLOCK_MS } }))
    const workerStall = await longestMainThreadStall(driveOneOperation(workerRuntime, workerDb.dbPath, "op-isolation-worker"))

    const inProcessDb = tempDb("history-isolation-inprocess-")
    const inProcessRuntime = track(createInProcessHistoryPersistenceRuntime({}, (backend) => withSynchronousBlock(backend, BLOCK_MS)))
    const inProcessStall = await longestMainThreadStall(driveOneOperation(inProcessRuntime, inProcessDb.dbPath, "op-isolation-inprocess"))

    // NEGATIVE CONTROL FIRST: if this does not freeze, the metronome is blind and the assertion below means nothing.
    expect(inProcessStall).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)

    // The claim. Compared RELATIVELY as well as absolutely: an absolute bound alone turns every loaded CI machine into a false red, while the ratio survives a slow machine because both arms slow together.
    expect(workerStall).toBeLessThan(BLOCK_MS * 0.5)
    expect(inProcessStall).toBeGreaterThan(workerStall * 2)
  })
})
