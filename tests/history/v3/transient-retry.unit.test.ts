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

  // DI-5-followup-2: the linear backoff sum grows quadratically, so a large
  // maxAttempts × backoffMs product could wedge the drain (→ shutdown, which has
  // no abort signal here on purpose) for minutes. A maxTotalMs budget caps the
  // CUMULATIVE nominal backoff so an extreme config gives up early. These assert
  // the accumulated-budget logic (deterministic under the scale seam), not wall-clock.

  test("maxTotalMs caps the CUMULATIVE backoff below the attempt cap (extreme config can't wedge)", async () => {
    let calls = 0
    // backoff sequence 1000,2000,3000,...; cumulative BEFORE each sleep: 0,1000,3000.
    // With maxTotalMs=3000 the 3rd sleep (3000) would push cumulative to 6000>3000,
    // so it gives up after 3 attempts — NOT the 100-attempt cap.
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true)) // always transient
      },
      { maxAttempts: 100, backoffMs: 1000, maxTotalMs: 3000 },
    )
    expect(res.ok).toBe(false)
    expect(res.attempts).toBe(3)
    expect(calls).toBe(3)
  })

  test("POSITIVE CONTROL: the SAME config without maxTotalMs runs to the attempt cap", async () => {
    // Proves the previous test's early stop is the time cap, not the attempt cap.
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 6, backoffMs: 1000 }, // no maxTotalMs
    )
    expect(res.attempts).toBe(6)
    expect(calls).toBe(6)
  })

  test("maxTotalMs: 0 disables the time cap (only maxAttempts bounds)", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 5, backoffMs: 1000, maxTotalMs: 0 },
    )
    expect(res.attempts).toBe(5)
    expect(calls).toBe(5)
  })

  test("the attempt-count cap still wins when it is tighter than the time cap", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 2, backoffMs: 10, maxTotalMs: 1_000_000 }, // huge budget, tiny attempt cap
    )
    expect(res.attempts).toBe(2)
    expect(calls).toBe(2)
  })
})
