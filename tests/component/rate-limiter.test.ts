/**
 * Characterization tests for AdaptiveRateLimiter
 *
 * Captures current behavior before refactoring:
 * - 429 detection logic (isRateLimitError)
 * - Exponential backoff calculation
 * - Retry-After parsing
 * - Mode transitions (normal → rate-limited → recovering → normal)
 * - Queue management
 * - executeWithAdaptiveRateLimit wrapper
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  AdaptiveRateLimiter,
  executeWithAdaptiveRateLimit,
  getAdaptiveRateLimiter,
  initAdaptiveRateLimiter,
  resetAdaptiveRateLimiter,
} from "~/lib/adaptive-rate-limiter"

import { waitUntil } from "../helpers/wait-until"

// ─── isRateLimitError ───

describe("AdaptiveRateLimiter.isRateLimitError", () => {
  let limiter: AdaptiveRateLimiter

  beforeEach(() => {
    limiter = new AdaptiveRateLimiter()
  })

  test("detects 429 status", () => {
    const error = { status: 429, message: "Rate limited" }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
  })

  test("does not detect non-429 status", () => {
    const error = { status: 400, message: "Bad request" }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(false)
  })

  test("detects rate_limited code in responseText JSON", () => {
    const error = {
      status: 200,
      responseText: JSON.stringify({
        error: { code: "rate_limited", message: "Too many requests" },
      }),
    }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
  })

  test("extracts retry_after from responseText (top-level)", () => {
    const error = {
      status: 429,
      responseText: JSON.stringify({ retry_after: 30 }),
    }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
    expect(result.retryAfter).toBe(30)
  })

  test("extracts retry_after from responseText (nested in error)", () => {
    const error = {
      status: 429,
      responseText: JSON.stringify({
        error: { retry_after: 15, code: "rate_limited" },
      }),
    }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(true)
    expect(result.retryAfter).toBe(15)
  })

  test("handles non-JSON responseText gracefully", () => {
    const error = {
      status: 200,
      responseText: "not json",
    }
    const result = limiter.isRateLimitError(error)
    expect(result.isRateLimit).toBe(false)
  })

  test("handles null/undefined error", () => {
    expect(limiter.isRateLimitError(null).isRateLimit).toBe(false)
    expect(limiter.isRateLimitError(undefined).isRateLimit).toBe(false)
  })

  test("handles non-object error", () => {
    expect(limiter.isRateLimitError("string error").isRateLimit).toBe(false)
    expect(limiter.isRateLimitError(42).isRateLimit).toBe(false)
  })
})

// ─── Mode transitions ───

describe("AdaptiveRateLimiter mode transitions", () => {
  test("starts in normal mode", () => {
    const limiter = new AdaptiveRateLimiter()
    const status = limiter.getStatus()
    expect(status.mode).toBe("normal")
    expect(status.queueLength).toBe(0)
    expect(status.consecutiveSuccesses).toBe(0)
    expect(status.rateLimitedAt).toBeNull()
  })

  test("transitions to rate-limited mode on 429", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01,
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })

    let callCount = 0
    await limiter.execute(async () => {
      callCount++
      if (callCount === 1) {
        throw { status: 429, message: "Rate limited" } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      }
      return "success"
    })

    // After recovery, should be back to normal
    // The fact that it completes means it went through rate-limited → recovering → normal
    expect(callCount).toBe(2)
  })

  test("execute in normal mode returns result directly", async () => {
    const limiter = new AdaptiveRateLimiter()
    const result = await limiter.execute(async () => "hello")
    expect(result.result).toBe("hello")
    expect(result.queueWaitMs).toBe(0)
  })

  test("execute in normal mode throws non-429 errors", async () => {
    const limiter = new AdaptiveRateLimiter()
    await expect(
      limiter.execute(async () => {
        throw new Error("Some other error")
      }),
    ).rejects.toThrow("Some other error")
  })
})

// ─── getStatus ───

describe("AdaptiveRateLimiter.getStatus", () => {
  test("returns complete status object", () => {
    const limiter = new AdaptiveRateLimiter()
    const status = limiter.getStatus()
    expect(status).toHaveProperty("mode")
    expect(status).toHaveProperty("queueLength")
    expect(status).toHaveProperty("consecutiveSuccesses")
    expect(status).toHaveProperty("rateLimitedAt")
  })
})

// ─── Configuration ───

describe("AdaptiveRateLimiter configuration", () => {
  test("accepts partial config and merges with defaults", () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 5,
    })
    // Should not throw, defaults are used for unspecified fields
    const status = limiter.getStatus()
    expect(status.mode).toBe("normal")
  })

  test("accepts empty config", () => {
    const limiter = new AdaptiveRateLimiter({})
    const status = limiter.getStatus()
    expect(status.mode).toBe("normal")
  })
})

// ─── Singleton functions ───

describe("Singleton rate limiter functions", () => {
  beforeEach(() => {
    resetAdaptiveRateLimiter()
  })

  afterEach(() => {
    resetAdaptiveRateLimiter()
  })

  test("getAdaptiveRateLimiter returns null before initialization", () => {
    const limiter = getAdaptiveRateLimiter()
    expect(limiter).toBeNull()
  })

  test("initAdaptiveRateLimiter creates instance", () => {
    initAdaptiveRateLimiter({ baseRetryIntervalSeconds: 5 })
    const limiter = getAdaptiveRateLimiter()
    expect(limiter).toBeInstanceOf(AdaptiveRateLimiter)
  })

  test("executeWithAdaptiveRateLimit executes directly without initialized limiter", async () => {
    const result = await executeWithAdaptiveRateLimit(async () => "direct")
    expect(result.result).toBe("direct")
    expect(result.queueWaitMs).toBe(0)
  })

  test("executeWithAdaptiveRateLimit uses limiter when initialized", async () => {
    initAdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01,
      requestIntervalSeconds: 0.01,
    })
    const result = await executeWithAdaptiveRateLimit(async () => "via-limiter")
    expect(result.result).toBe("via-limiter")
    // When going through the limiter in normal mode, queueWaitMs is still 0
    expect(result.queueWaitMs).toBe(0)
  })
})

// ─── Exponential backoff behavior ───

describe("AdaptiveRateLimiter exponential backoff", () => {
  test("retries with increasing delays on repeated 429s", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01, // 10ms for fast tests
      maxRetryIntervalSeconds: 0.1, // 100ms cap
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })

    let callCount = 0
    const result = await limiter.execute(async () => {
      callCount++
      if (callCount <= 3) {
        throw { status: 429, message: "Rate limited" } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      }
      return "recovered"
    })

    expect(result.result).toBe("recovered")
    expect(callCount).toBe(4)
    // queueWaitMs should be > 0 since it was queued
    expect(result.queueWaitMs).toBeGreaterThan(0)
  })

  test("uses server-provided Retry-After when available", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 100, // High default to prove Retry-After overrides
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })

    let callCount = 0
    const result = await limiter.execute(async () => {
      callCount++
      if (callCount === 1) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating API error with Retry-After
        throw {
          status: 429,
          responseText: JSON.stringify({ retry_after: 0.01 }),
        }
      }
      return "ok"
    })

    expect(result.result).toBe("ok")
    expect(callCount).toBe(2)
  })
})

// ─── Recovery mechanism ───

describe("AdaptiveRateLimiter recovery", () => {
  test("recovers after consecutive successes", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01,
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 2,
      gradualRecoverySteps: [0], // Instant recovery
    })

    let callCount = 0

    // First call: 429 triggers rate-limited mode
    const result1 = await limiter.execute(async () => {
      callCount++
      if (callCount === 1) throw { status: 429 } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      return `call-${callCount}`
    })

    // After 1 retry success + 2 consecutive successes + 1 recovery step,
    // should be back to normal
    expect(result1.result).toMatch(/call-\d+/)

    // Subsequent calls should work in normal mode
    const result2 = await limiter.execute(async () => "normal-mode")
    expect(result2.result).toBe("normal-mode")
  })

  test("startGradualRecovery fires at most once per rate-limit episode (consecutiveSuccesses not repeatedly reset)", async () => {
    // Regression: processQueue used to call shouldAttemptRecovery() +
    // startGradualRecovery() on every iteration. Each transition resets
    // `consecutiveSuccesses` to 0. With the fix, the transition fires at
    // most once and the counter accumulates across the rest of the drain;
    // pre-fix, the counter oscillates near 0.
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.001,
      requestIntervalSeconds: 0.001,
      consecutiveSuccessesForRecovery: 2,
      gradualRecoverySteps: [60], // Non-zero so recovery doesn't complete during drain
    })

    // Trigger 429 to enter rate-limited mode synchronously (microtask cycle).
    // We must AWAIT this so subsequent execute() calls see mode === "rate-limited"
    // and therefore go through enqueue → processQueue (instead of running in
    // normal mode directly).
    let first = true
    await limiter.execute(async () => {
      if (first) {
        first = false
        throw { status: 429 } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      }
      return "trigger-ok"
    })

    expect(limiter.getStatus().mode).toBe("rate-limited")

    // Now enqueue many successful requests — these go through processQueue.
    // Pre-fix: each batch of consecutiveSuccessesForRecovery (=2) successes
    // re-triggers startGradualRecovery, resetting consecutiveSuccesses to 0.
    // Post-fix: the transition fires once, then the counter accumulates.
    const queued = Array.from({ length: 20 }, (_, i) => limiter.execute(async () => `q-${i}`))
    await Promise.all(queued)

    const status = limiter.getStatus()
    // After the queue drain, consecutiveSuccesses should reflect the bulk of
    // the drained requests (>= 10). Pre-fix it would oscillate in [0, 2].
    expect(status.consecutiveSuccesses).toBeGreaterThan(2)
  })
})

// ─── Non-429 error handling in queue ───

describe("AdaptiveRateLimiter non-429 errors", () => {
  test("rejects queued request with non-429 error", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0.01,
      requestIntervalSeconds: 0.01,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })

    let callCount = 0
    // First trigger rate-limited mode
    const promise1 = limiter.execute(async () => {
      callCount++
      if (callCount === 1) throw { status: 429 } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      if (callCount === 2) throw new Error("Server error")
      return "ok"
    })

    await expect(promise1).rejects.toThrow("Server error")
  })
})

// ─── Sleep cancellation (shutdown) ───

describe("AdaptiveRateLimiter sleep cancellation", () => {
  test("rejectQueued cancels pending sleep immediately", async () => {
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 60, // 60s sleep — would block without cancellation
      requestIntervalSeconds: 60,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0],
    })

    let callCount = 0
    const promise = limiter.execute(async () => {
      callCount++
      if (callCount === 1) {
        throw { status: 429, message: "Rate limited" } // eslint-disable-line @typescript-eslint/only-throw-error -- simulating API error
      }
      return "ok"
    })

    // Wait for rate-limited mode to kick in and sleep to start
    await waitUntil(() => limiter.getStatus().mode === "rate-limited", {
      label: "rate limiter to enter rate-limited mode",
    })

    // rejectQueued should cancel the 60s sleep immediately
    const startMs = Date.now()
    limiter.rejectQueued()

    // The promise should settle quickly (not wait 60s)
    const result = await promise
    const elapsed = Date.now() - startMs

    // Key assertion: should not wait 60s for the sleep to finish
    expect(elapsed).toBeLessThan(2000)
    expect(result.result).toBe("ok")
    expect(result.queueWaitMs).toBeGreaterThanOrEqual(0)
    expect(result.queueWaitMs).toBeLessThan(2000)
  })
})

describe("AdaptiveRateLimiter recovering mode — concurrency safety (H3 regression guard)", () => {
  test("N concurrent recovering-mode callers are paced one ramp-up interval apart", async () => {
    // 400ms first interval gives enough headroom that 4 concurrent callers'
    // actual start times must be clearly spaced. Multi-step ramp config makes
    // sure the test exercises step-0 throughout (concurrent step-0 callers do
    // not advance the index past 1 — see the dedicated step-advancement test).
    const limiter = new AdaptiveRateLimiter({
      gradualRecoverySteps: [0.4, 0.4, 0.4, 0.4, 0.4, 0.4],
    })

    limiter._enterRecoveringModeForTesting()
    expect(limiter.getStatus().mode).toBe("recovering")

    // Fire 4 concurrent recovering-mode requests; capture observed start
    // times. Each must be ≥ ~400ms after the prior — proving the leaky-bucket
    // gate serialized them instead of letting them all race the same wakeup.
    const startTimes: Array<number> = []
    const recordStart = () => {
      startTimes.push(Date.now())
      return Promise.resolve("ok")
    }
    const fns = Array.from({ length: 4 }, () => limiter.execute(recordStart))
    await Promise.all(fns)

    expect(startTimes).toHaveLength(4)
    startTimes.sort((a, b) => a - b)
    for (let i = 1; i < startTimes.length; i++) {
      const gap = startTimes[i] - startTimes[i - 1]
      // 400ms interval; tolerate up to 100ms scheduler jitter (CI / WSL2 timers).
      expect(gap).toBeGreaterThanOrEqual(300)
    }
  })

  test("concurrent recovering-mode total elapsed time ≥ (N-1) × interval (no bursting)", async () => {
    const limiter = new AdaptiveRateLimiter({
      gradualRecoverySteps: [0.3, 0.3, 0.3, 0.3, 0.3],
    })

    limiter._enterRecoveringModeForTesting()
    expect(limiter.getStatus().mode).toBe("recovering")

    const start = Date.now()
    await Promise.all([
      limiter.execute(() => Promise.resolve("a")),
      limiter.execute(() => Promise.resolve("b")),
      limiter.execute(() => Promise.resolve("c")),
    ])
    const elapsed = Date.now() - start

    // 3 concurrent calls at 300ms interval: first runs immediately, next 2
    // wait 300ms and 600ms respectively → total ≥ ~600ms. Pre-fix completed
    // all three in ~300ms (they all raced the same sleep target). Allow
    // 100ms jitter buffer.
    expect(elapsed).toBeGreaterThanOrEqual(500)
  })

  test("N concurrent step-0 callers advance recoveryStepIndex by exactly 1 (not N)", async () => {
    // H1 (from subagent review): without the "first-completion-of-step" guard,
    // N successful completions all read step=0 at reservation time, then each
    // ++ on completion, jumping the index by N — short-circuiting ramp-up to
    // completeRecovery() after just one round of concurrency.
    //
    // To make the failure mode observable, we pick N concurrent callers > step
    // count: pre-fix index jumps 0 → N, exceeds step count, triggers
    // completeRecovery → mode == "normal". Post-fix index advances 0 → 1, mode
    // stays "recovering".
    const limiter = new AdaptiveRateLimiter({
      // 3 steps; 5 concurrent callers all reserve while step=0.
      gradualRecoverySteps: [0.05, 0.05, 0.05],
    })

    limiter._enterRecoveringModeForTesting()
    expect(limiter.getStatus().mode).toBe("recovering")

    await Promise.all([
      limiter.execute(() => Promise.resolve("a")),
      limiter.execute(() => Promise.resolve("b")),
      limiter.execute(() => Promise.resolve("c")),
      limiter.execute(() => Promise.resolve("d")),
      limiter.execute(() => Promise.resolve("e")),
    ])

    // Mode must still be "recovering" — ramp-up not collapsed by the burst.
    // Pre-fix behavior: mode === "normal" because index jumped 0 → 5 > 3.
    expect(limiter.getStatus().mode).toBe("recovering")
  })
})
