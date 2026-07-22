import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  drainV3Writer,
  enqueueModelOperation,
  getV3Operation,
  getV3StoreStatus,
  resetV3WriterForTests,
  setV3CommitFailureInjectorForTests,
  setV3PersistRetryConfig,
} from "~/lib/history/v3/store"
import {
  //
  drainModelOperationTerminalSubscribers,
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"
import {
  //
  resetAbortableDelayScaleForTests,
  setAbortableDelayScaleForTests,
} from "~/lib/util/abortable-delay"

// DI-5 end-to-end: prove the drain is ACTUALLY wired to runWithTransientRetry
// (not just that the helper exists). We fail the operation transaction once with
// a transient (WAL "database is locked") error and check the entry survives —
// with a positive-control case (maxAttempts=1 → the entry is dropped, proving the
// test really detects the drop; catching-false-green-tests).

/** Make the commit attempt throw a transient error its first `n` runs, via the store seam. */
function injectTransientTxFailures(n: number): { remaining: () => number } {
  let failsLeft = n
  setV3CommitFailureInjectorForTests(() => {
    if (failsLeft > 0) {
      failsLeft--
      throw new Error("database is locked") // classified transient by persist-guard
    }
  })
  return { remaining: () => failsLeft }
}

async function enqueueOneTerminal(): Promise<string> {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.beginAttempt({})
  ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: "ok" })
  ctx.finalizeModelOperationDelivery({ clientPayload: { role: "assistant", content: "ok" } })
  await ctx.whenModelOperationFinalized()
  return ctx.id
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
  subscribeModelOperationTerminals(enqueueModelOperation)
  setAbortableDelayScaleForTests(0) // backoff instant
})

afterEach(async () => {
  setV3CommitFailureInjectorForTests(null)
  await drainV3Writer()
  closeDatabase()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
  resetAbortableDelayScaleForTests()
  setV3PersistRetryConfig({ maxAttempts: 3, backoffMs: 10 })
})

describe("DI-5 drain transient retry (end-to-end)", () => {
  test("POSITIVE CONTROL: with retry disabled (maxAttempts=1) a transient failure DROPS the entry", async () => {
    setV3PersistRetryConfig({ maxAttempts: 1, backoffMs: 0 })
    const injected = injectTransientTxFailures(1) // arm BEFORE enqueue (complete → drain is synchronous)
    const id = await enqueueOneTerminal()
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()

    // The injected failure fired, and with no retry the entry is lost + counted failed.
    expect(injected.remaining()).toBe(0)
    expect(getV3Operation(id)).toBeUndefined()
    expect(getV3StoreStatus().failedOperations).toBe(1)
  })

  test("with retry (default) a single transient failure is retried and the entry survives", async () => {
    const injected = injectTransientTxFailures(1)
    const id = await enqueueOneTerminal()
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()

    expect(injected.remaining()).toBe(0) // the transient failure did fire
    expect(getV3Operation(id)).toBeDefined() // ...but the retry landed it
    expect(getV3StoreStatus().failedOperations).toBe(0)
    expect(getV3StoreStatus().persistedOperations).toBe(1)
  })

  test("a persistent transient storm past the cap is bounded and counted failed (not an infinite spin)", async () => {
    setV3PersistRetryConfig({ maxAttempts: 3, backoffMs: 0 })
    const injected = injectTransientTxFailures(10) // more failures than the cap
    const id = await enqueueOneTerminal()
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()

    expect(injected.remaining()).toBe(7) // exactly 3 attempts consumed, then gave up
    expect(getV3Operation(id)).toBeUndefined()
    expect(getV3StoreStatus().failedOperations).toBe(1)
  })

  test("DI-5-followup-2: max_total_ms bounds the drain below an extreme attempt cap (no shutdown wedge)", async () => {
    // Extreme config: 100 attempts × 1000ms base backoff would take ~82 minutes of
    // cumulative backoff. The cumulative-backoff cap (3000ms) makes the drain give
    // up after 3 attempts instead — proving maxTotalMs reaches the drain end-to-end.
    setV3PersistRetryConfig({ maxAttempts: 100, backoffMs: 1000, maxTotalMs: 3000 })
    const injected = injectTransientTxFailures(50) // far more failures than the time cap allows attempts
    const id = await enqueueOneTerminal()
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()

    expect(injected.remaining()).toBe(47) // only 3 attempts consumed (cumulative 0+1000+2000 ≤ 3000; 4th would exceed)
    expect(getV3Operation(id)).toBeUndefined()
    expect(getV3StoreStatus().failedOperations).toBe(1)
  })
})
