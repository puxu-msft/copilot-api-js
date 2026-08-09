/**
 * Batch 2b: process startup gives up on History instead of hanging forever.
 *
 * The Worker's startup retries are rate-limited but uncapped by design — a `SQLITE_BUSY` may clear on the next attempt, and turning "tried N times" into a fatal would make a temporary fault permanent for the life of the process (that cap was added in Batch 2a and withdrawn by user ruling). The consequence is that a peer holding the write lock indefinitely leaves `initHistory` neither resolved nor rejected, and spec §8.1 forbids listening before History is ready — so the process serves nothing and exits with nothing. The deadline is the piece that turns that silence back into a failure.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

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
import { initHistory } from "~/lib/history/state"
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
  private abandonStart: ((error: Error) => void) | undefined

  start(): Promise<HistoryWorkerReady> {
    return new Promise<HistoryWorkerReady>((_resolve, reject) => {
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

  shutdown(): Promise<void> {
    return Promise.resolve()
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

  test("disabling History is never subject to the deadline", async () => {
    // Bringing History DOWN does no I/O and cannot hang; a deadline there would put a timer on every start that runs without History.
    setHistoryStartupDeadlineMs(1)
    await initHistoryWithinStartupDeadline(false)
  })

  test("config drives the deadline the process entry point uses", () => {
    // The entry point calls the function with no argument, so a configured value only reaches it through this module-local default.
    expect(getHistoryStartupDeadlineMs()).toBe(HISTORY_STARTUP_DEADLINE_MS)
    setHistoryStartupDeadlineMs(500)
    expect(getHistoryStartupDeadlineMs()).toBe(500)
  })
})
