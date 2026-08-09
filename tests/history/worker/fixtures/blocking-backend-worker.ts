import { parentPort, workerData } from "node:worker_threads"

import {
  //
  createHistoryWorkerBackend,
  installHistoryWorkerMessageLoop,
} from "~/lib/history/worker/backend"

import { withSynchronousBlock } from "./blocking-backend"

/**
 * Worker entry whose History work blocks its thread synchronously.
 *
 * This is the positive arm of Batch 2b's central claim: the block runs where the real backend runs, over the real message loop, so if persistence were still wired to the main thread the main thread would freeze. The negative arm (`createInProcessHistoryPersistenceRuntime` with the same wrapper) removes only the thread boundary and MUST freeze — see event-loop-isolation.it.test.ts.
 */
interface BlockingBackendFixture {
  readonly blockMs: number
}

if (!parentPort) throw new Error("blocking-backend-worker fixture requires a parent port")

const fixture = workerData as BlockingBackendFixture

installHistoryWorkerMessageLoop(parentPort, withSynchronousBlock(createHistoryWorkerBackend(), fixture.blockMs))
