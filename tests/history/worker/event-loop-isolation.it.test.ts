/**
 * Batch 2b Step 2b.4 — the central claim of the cutover: History's synchronous work no longer freezes the main thread.
 *
 * Every other test in this batch would still pass if the "cutover" had moved the connection object into the Worker while leaving some compression / prepare / commit call wired to the main thread: rows land, outcomes arrive, the protocol is honoured — and the proxy stalls on every request anyway. Only a timing observation separates those two worlds.
 *
 * The pair is deliberately symmetric. Both arms drive the SAME backend through the SAME message loop with the SAME injected block (`withSynchronousBlock`); the only difference is whether a thread boundary sits in between. The in-process arm is the negative control that proves the probe can see a freeze at all — without it, "the main thread stayed responsive" is indistinguishable from "the metronome cannot detect anything".
 *
 * Both observations named by the plan are taken: the metronome (fine-grained, measures the loop itself) and a real `/health/liveness` request through the app (coarse, but it is the thing an operator actually probes). Keeping only the timer was tempting and wrong — a timer cannot show that HTTP dispatch completes inside the blocking window.
 *
 * Measured when the liveness leg was added: worker arm stalls 32ms and answers `/health/liveness` in 10ms; in-process arm stalls 1050ms (two 500ms blocks with no tick in between) and takes 532ms to answer the same probe. Both return 200 — the difference is entirely in when. The thresholds sit far inside those gaps on purpose; re-measure rather than relax them if this ever runs close.
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

import { createFullTestApp } from "../../helpers/test-app"

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
const app = createFullTestApp()

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
 * Longest stretch during which the main thread could not run a timer callback, plus how long a real `/health/liveness` request took while the same work was in flight.
 *
 * Two observations of one property, kept together on purpose. The metronome measures the event loop directly and finely; the liveness request is the user-visible end of it — an operator's probe, served by the same loop, through the real app and router. Task 2b.4 names both, and a timer alone cannot show that HTTP dispatch actually completes inside the blocking window.
 */
async function observeMainThreadDuring(drive: () => Promise<void>): Promise<{ stall: number; livenessMs: number; livenessStatus: number; elapsed: number }> {
  const ticks: Array<number> = [Date.now()]
  const metronome = setInterval(() => ticks.push(Date.now()), TICK_MS)
  let livenessMs = 0
  let livenessStatus = 0
  const startedAt = Date.now()
  try {
    const driven = drive()
    // Issued WHILE the work is in flight, not after it: the question is whether the probe can be served during the block, so it must be racing the block rather than following it.
    const probeStartedAt = Date.now()
    const response = await app.request("/health/liveness")
    livenessMs = Date.now() - probeStartedAt
    livenessStatus = response.status
    await driven
  } finally {
    clearInterval(metronome)
  }
  const elapsed = Date.now() - startedAt
  ticks.push(Date.now())

  let longest = 0
  for (let i = 1; i < ticks.length; i++) longest = Math.max(longest, ticks[i] - ticks[i - 1])
  return { stall: longest, livenessMs, livenessStatus, elapsed }
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
    const worker = await observeMainThreadDuring(driveOneOperation(workerRuntime, workerDb.dbPath, "op-isolation-worker"))

    const inProcessDb = tempDb("history-isolation-inprocess-")
    const inProcessRuntime = track(createInProcessHistoryPersistenceRuntime({}, (backend) => withSynchronousBlock(backend, BLOCK_MS)))
    const inProcess = await observeMainThreadDuring(driveOneOperation(inProcessRuntime, inProcessDb.dbPath, "op-isolation-inprocess"))

    // NEGATIVE CONTROL FIRST: if this does not freeze, the metronome is blind and the assertion below means nothing.
    expect(inProcess.stall).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)

    // The positive arm needs its own proof that the block HAPPENED. Without this, a fixture that silently stopped injecting it — a `workerData` field renamed, `withSynchronousBlock` no longer wrapped around the entry — would produce a small stall in the Worker arm and a large one in-process, and every assertion below would pass while the arm that is supposed to demonstrate isolation demonstrated nothing at all. Both `initialize` and `persist` are blocked, so the work takes at least two blocks; it just does not take them out of THIS thread.
    expect(worker.elapsed).toBeGreaterThanOrEqual(BLOCK_MS * 2 * 0.8)

    // The claim. Compared RELATIVELY as well as absolutely: an absolute bound alone turns every loaded CI machine into a false red, while the ratio survives a slow machine because both arms slow together.
    expect(worker.stall).toBeLessThan(BLOCK_MS * 0.5)
    expect(inProcess.stall).toBeGreaterThan(worker.stall * 2)

    // The same property at the user-visible end: an operator's liveness probe is answered during the Worker's block, and is held hostage by the in-process one.
    expect(worker.livenessStatus).toBe(200)
    expect(inProcess.livenessStatus).toBe(200)
    expect(worker.livenessMs).toBeLessThan(BLOCK_MS * 0.5)
    expect(inProcess.livenessMs).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)
  })
})
