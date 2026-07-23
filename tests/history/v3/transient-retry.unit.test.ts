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

  // DI-5-followup-2: maxTotalMs is a real WALL-CLOCK cap on the total time one
  // commit may spend retrying — including each attempt's OWN blocking (a SQLite
  // busy_timeout wait is the bulk of a real wedge), which a nominal-backoff-only
  // budget would miss. Time is driven deterministically through the `now` seam
  // (default Date.now in prod); backoff stays instant (scale 0).

  /** A deterministic clock: starts at 0, advances by `stepMs` on each read. */
  function fakeClock(stepMs: number): () => number {
    let t = -stepMs // first read (startedAt) returns 0
    return () => (t += stepMs)
  }

  test("maxTotalMs counts each attempt's OWN blocking time (the real wedge), not just backoff", async () => {
    // clock advances 1000ms per read with ZERO backoff, so the only thing consuming
    // the budget is elapsed time between reads (models a slow attempt). startedAt=0,
    // then reads at 1000,2000,3000,4000... The check `now()-0+0 > 3000` first trips
    // at the read returning 4000 → attempts=4. Proves attempt-blocking counts.
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true)) // always transient
      },
      { maxAttempts: 100, backoffMs: 0, maxTotalMs: 3000, now: fakeClock(1000) },
    )
    expect(res.ok).toBe(false)
    expect(res.attempts).toBe(4)
    expect(res.capReason).toBe("max-total-ms")
    expect(calls).toBe(4)
  })

  test("POSITIVE CONTROL: the SAME slow clock without maxTotalMs runs to the attempt cap", async () => {
    // Proves the previous test's early stop is the time cap, not the attempt cap.
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 6, backoffMs: 0, now: fakeClock(1000) }, // no maxTotalMs
    )
    expect(res.attempts).toBe(6)
    expect(res.capReason).toBe("max-attempts")
    expect(calls).toBe(6)
  })

  test("the predicted next backoff is included so the loop never sleeps PAST the budget", async () => {
    // Clock frozen at 0 (attempts instant); only the predictive `elapsed + nextBackoff`
    // term can trip the cap. backoff 1000,2000,3000,4000; cap 3000 → the 4th (4000)
    // would overshoot (3rd's 3000 is not > 3000), so it gives up at attempt 4.
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 100, backoffMs: 1000, maxTotalMs: 3000, now: () => 0 },
    )
    expect(res.attempts).toBe(4)
    expect(res.capReason).toBe("max-total-ms")
    expect(calls).toBe(4)
  })

  test("maxTotalMs: 0 disables the time cap (only maxAttempts bounds)", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 5, backoffMs: 1000, maxTotalMs: 0, now: fakeClock(100_000) }, // huge elapsed, cap disabled
    )
    expect(res.attempts).toBe(5)
    expect(res.capReason).toBe("max-attempts")
    expect(calls).toBe(5)
  })

  test("the attempt-count cap still wins (with its capReason) when it is tighter than the time cap", async () => {
    let calls = 0
    const res = await runWithTransientRetry(
      () => {
        calls++
        return Promise.resolve(outcome(false, true))
      },
      { maxAttempts: 2, backoffMs: 10, maxTotalMs: 1_000_000 }, // huge budget, tiny attempt cap
    )
    expect(res.attempts).toBe(2)
    expect(res.capReason).toBe("max-attempts")
    expect(calls).toBe(2)
  })
})
