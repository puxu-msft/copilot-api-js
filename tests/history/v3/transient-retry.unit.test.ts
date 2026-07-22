import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import { runWithTransientRetry } from "~/lib/history/v3/store"
import {
  //
  resetAbortableDelayScaleForTests,
  setAbortableDelayScaleForTests,
} from "~/lib/util/abortable-delay"

// DI-5: the V3 drain used to ignore `PersistResult.transient` — a WAL BUSY/LOCKED
// hiccup on the commit was counted as failed and the entry dropped, with no retry
// even though persist-guard had already classified it as retryable. These lock the
// retain-and-retry decision (transient → bounded backoff retry; permanent/conflict
// → give up immediately; hard cap so a transient storm can't spin forever).

// Backoff resolves instantly under the test scale (mirrors the isolated fixture).
setAbortableDelayScaleForTests(0)
afterEach(() => setAbortableDelayScaleForTests(0))

function outcome(ok: boolean, transient: boolean, conflict = false) {
  return { ok, transient, conflict }
}

describe("runWithTransientRetry", () => {
  test("transient failures are retried until success", async () => {
    const results = [outcome(false, true), outcome(false, true), outcome(true, false)]
    let calls = 0
    const res = await runWithTransientRetry(() => Promise.resolve(results[calls++]), { maxAttempts: 5, backoffMs: 10 })
    expect(res.ok).toBe(true)
    expect(res.attempts).toBe(3) // failed, failed, succeeded
  })

  test("permanent failure is NOT retried (retry is pointless)", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, false)) // permanent
      },
      { maxAttempts: 5, backoffMs: 10 },
    )
    expect(res.ok).toBe(false)
    expect(res.attempts).toBe(1)
    expect(calls).toBe(1)
  })

  test("conflict returns immediately (data-contract violation, not a persistence failure)", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, false, true)) // conflict
      },
      { maxAttempts: 5, backoffMs: 10 },
    )
    expect(res.conflict).toBe(true)
    expect(res.attempts).toBe(1)
    expect(calls).toBe(1)
  })

  test("a transient storm is bounded by maxAttempts (soft cap, no infinite spin)", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true)) // always transient
      },
      { maxAttempts: 3, backoffMs: 10 },
    )
    expect(res.ok).toBe(false)
    expect(res.attempts).toBe(3)
    expect(calls).toBe(3)
  })

  test("maxAttempts is floored at 1 (never zero attempts)", async () => {
    let calls = 0
    await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(true, false))
      },
      { maxAttempts: 0, backoffMs: 10 },
    )
    expect(calls).toBe(1)
  })

  test("aborted signal short-circuits the backoff (no wedge at shutdown)", async () => {
    // With a real (non-zero) scale but an already-aborted signal, backoff rejects
    // instantly (OperationCancelledError, swallowed) so the retry loop still bounds.
    resetAbortableDelayScaleForTests() // scale = 1 (real ms)
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const res = await runWithTransientRetry(() => Promise.resolve(outcome(false, true)), {
      maxAttempts: 3,
      backoffMs: 10_000,
      signal: controller.signal,
    })
    // Would take 30s if backoff weren't short-circuited by the aborted signal.
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.attempts).toBe(3)
  })
})
