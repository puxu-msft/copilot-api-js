/**
 * Batch 2b: process startup gives up on History instead of hanging forever.
 *
 * The Worker's startup retries are rate-limited but uncapped by design — a `SQLITE_BUSY` may clear on the next attempt, and turning "tried N times" into a fatal would make a temporary fault permanent for the life of the process (that cap was added in Batch 2a and withdrawn by user ruling). The consequence is that a peer holding the write lock indefinitely leaves `initHistory` neither resolved nor rejected, and spec §8.1 forbids listening before History is ready — so the process serves nothing and exits with nothing. The deadline is the piece that turns that silence back into a failure.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  //
  HistoryDrainResult,
  HistoryMessageId,
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
  HistoryWorkerReady,
  HistoryWorkerStatus,
} from "~/lib/history/worker/protocol"
import type { HistoryPersistenceRuntime } from "~/lib/history/worker/runtime"

import {
  //
  HISTORY_STARTUP_DEADLINE_MS,
  HistoryStartupDeadlineError,
  getHistoryStartupDeadlineMs,
  initHistoryWithinStartupDeadline,
  setHistoryStartupDeadlineMs,
} from "~/lib/history/startup-deadline"
import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import { initHistory } from "~/lib/history/state"
import { ensureV3Schema } from "~/lib/history/v3/store"
import { setHistoryPersistenceRuntimeForTests } from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"

/**
 * A runtime stuck exactly where the real one gets stuck: `start()` never settles, while the status keeps reporting that retries are happening.
 *
 * The counters are the point — an operator has to be able to tell "the Worker is fighting a locked database" from "the Worker never got scheduled", and the deadline error is the only place that information reaches them.
 */
class NeverReadyRuntime implements HistoryPersistenceRuntime {
  consecutiveFailures = 4
  nextRetryAt = 1_754_000_000_000
  /** When set, `start()` rejects immediately instead of hanging — the ordinary failure shape, as opposed to the stuck one. */
  failStartWith: Error | undefined
  /** When set, `start()` succeeds against this artifact, so the runtime can be brought UP and then taken back down. */
  startSucceedsAt: string | undefined
  /** Teardown takes this long, which is what makes "is the disable path subject to the deadline?" an answerable question. */
  shutdownDelayMs = 0
  private abandonStart: ((error: Error) => void) | undefined

  async start(): Promise<HistoryWorkerReady> {
    if (this.failStartWith) throw this.failStartWith
    if (this.startSucceedsAt) {
      const owned = openOwnedHistoryDatabase(this.startSucceedsAt)
      ensureV3Schema(owned)
      owned.close()
      return {
        workerGeneration: 1,
        threadId: 1,
        selectedDriver: "bun:sqlite",
        configRevision: 1,
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        recoveredJournalOperations: 0,
      } as HistoryWorkerReady
    }
    return await new Promise<HistoryWorkerReady>((_resolve, reject) => {
      // Intentionally never settles on its own: the retry loop is still going.
      this.abandonStart = reject
    })
  }

  /**
   * Let the stuck bring-up finally fail.
   *
   * Cleanup needs this because the deadline does NOT cancel anything — that is the documented contract, and it means a test cannot tear down through `shutdownHistory()`/`initHistory(false)`: those queue behind the very transition that is not finishing. The production answer to this state is to exit the process; a test's answer is to end the thing production would have exited on.
   */
  abandon(): void {
    this.abandonStart?.(new Error("[test] abandoning the stuck bring-up"))
  }

  enqueue(_envelope: HistoryOperationEnvelope, _onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    return 1
  }

  updateConfig(): Promise<never> {
    throw new Error("not used by this test")
  }

  stopMaintenance(): Promise<void> {
    return Promise.resolve()
  }

  drain(): Promise<HistoryDrainResult> {
    return Promise.resolve({ outcomes: {} })
  }

  async shutdown(): Promise<void> {
    if (this.shutdownDelayMs > 0) await Bun.sleep(this.shutdownDelayMs)
  }

  snapshot(): HistoryWorkerStatus {
    return {
      workerGeneration: 1,
      ready: false,
      terminalFailed: false,
      pendingEnvelopes: 0,
      pendingBytes: 0,
      latestDesiredRevision: 1,
      publishedRevision: 1,
      restartsTotal: 4,
      replaysTotal: 0,
      recoveredJournalOperations: 0,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
      staleMessagesTotal: 0,
      duplicateAcksTotal: 0,
      outcomeCallbackErrorsTotal: 0,
      statusObserverErrorsTotal: 0,
    }
  }

  subscribe(): () => void {
    return () => {}
  }
}

let stuck: NeverReadyRuntime | undefined

// Take History down before injecting: a predecessor file in this worker leaves it UP (the isolated fixture's teardown rebuilds it on purpose), and a bring-up against an already-installed History takes the idempotent branch instead of driving the double.
beforeEach(async () => {
  await initHistory(false)
})

afterEach(async () => {
  setHistoryStartupDeadlineMs(HISTORY_STARTUP_DEADLINE_MS)
  // Before anything that queues a lifecycle transition: a stuck bring-up blocks the queue forever, and every later `initHistory` in this worker — including the next file's — would wait behind it.
  stuck?.abandon()
  stuck = undefined
  setHistoryPersistenceRuntimeForTests(undefined)
  setStateForTests({ historyDbPath: "" })
  await initHistory(false)
})

describe("History startup deadline", () => {
  test("a bring-up that never settles is reported as a deadline failure, with the retry counters", async () => {
    stuck = new NeverReadyRuntime()
    setHistoryPersistenceRuntimeForTests(stuck)

    const failure = await initHistoryWithinStartupDeadline(true, 25).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(HistoryStartupDeadlineError)
    const deadlineError = failure as HistoryStartupDeadlineError
    // Not just "we gave up": the message has to say what the Worker was doing, or the operator cannot tell a locked database from a Worker that never started.
    expect(deadlineError.consecutiveFailures).toBe(4)
    expect(deadlineError.nextRetryAt).toBe(1_754_000_000_000)
    expect(deadlineError.message).toMatch(/startup deadline exceeded/)
    expect(deadlineError.message).toMatch(/25ms/)
  })

  test("a bring-up that fails on its own propagates that failure, not a deadline", async () => {
    // The ordinary failure path: the Worker rejects long before the deadline. The caller must see the real cause — a deadline error here would send an operator looking for a locked database instead of reading the actual one.
    const failing = new NeverReadyRuntime()
    failing.failStartWith = new Error("database file is not a database")
    setHistoryPersistenceRuntimeForTests(failing)

    const failure = await initHistoryWithinStartupDeadline(true, 30_000).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).not.toBeInstanceOf(HistoryStartupDeadlineError)
    expect((failure as Error).message).toMatch(/database file is not a database/)
  })

  test("disabling History is never subject to the deadline, even when teardown is slow", async () => {
    // Bringing History DOWN is not a bring-up and must not be raced against a deadline. Asserting that with an instant teardown would prove nothing — `initHistory(false)` beats any timer — so the runtime here takes 80ms to shut down while the deadline is 1ms. If the disable path were subject to the deadline, this would reject.
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deadline-disable-")), "history.db")
    const runtime = new NeverReadyRuntime()
    runtime.startSucceedsAt = dbPath
    runtime.shutdownDelayMs = 80
    setHistoryPersistenceRuntimeForTests(runtime)
    setStateForTests({ historyDbPath: dbPath })
    await initHistoryWithinStartupDeadline(true, 5000)

    setHistoryStartupDeadlineMs(1)
    const startedAt = Date.now()
    await initHistoryWithinStartupDeadline(false)
    // It waited for the slow teardown rather than giving up at 1ms.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60)
  })

  test("config drives the deadline the process entry point uses", () => {
    // The entry point calls the function with no argument, so a configured value only reaches it through this module-local default.
    expect(getHistoryStartupDeadlineMs()).toBe(HISTORY_STARTUP_DEADLINE_MS)
    setHistoryStartupDeadlineMs(500)
    expect(getHistoryStartupDeadlineMs()).toBe(500)
  })
})
