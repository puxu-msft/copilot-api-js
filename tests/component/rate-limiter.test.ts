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

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
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
