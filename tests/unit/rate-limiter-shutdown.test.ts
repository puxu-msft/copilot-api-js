/**
 * Unit tests for rate limiter rejectQueued method.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { AdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"

import { waitUntil } from "../helpers/wait-until"

describe("AdaptiveRateLimiter.rejectQueued", () => {
  let limiter: AdaptiveRateLimiter

  afterEach(() => {
    limiter?.rejectQueued()
  })

  test("returns 0 when queue is empty", () => {
    limiter = new AdaptiveRateLimiter()
    const count = limiter.rejectQueued()
    expect(count).toBe(0)
  })

  test("rejects queued requests with 'Server shutting down' error", async () => {
    limiter = new AdaptiveRateLimiter()

    // First call throws 429 to trigger rate-limited mode and re-enqueue
    let firstCallCount = 0
    const p1 = limiter
      .execute(async () => {
        firstCallCount++
        if (firstCallCount === 1) {
          const err = new Error("Rate limited") as any
          err.status = 429
          throw err
        }
        return "ok"
      })
      .catch((e: Error) => e)

    // Wait for the first request to be processed and re-enqueued
    await waitUntil(() => limiter.getStatus().mode === "rate-limited", {
      label: "rate limiter to enter rate-limited mode",
    })

    // Second call should be queued since we're now rate-limited
    const p2 = limiter.execute(async () => "result2").catch((e: Error) => e)

    // Wait for it to enter the queue
    await waitUntil(() => limiter.getStatus().queueLength > 0, {
      label: "second request to enter queue",
    })

    // Now reject all queued
    const count = limiter.rejectQueued()

    const [r1, r2] = await Promise.all([p1, p2])

    // At least one should have been rejected with shutdown error
    expect(count).toBeGreaterThanOrEqual(1)
    const errors = [r1, r2].filter((r) => r instanceof Error && r.message === "Server shutting down")
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  test("second rejectQueued returns 0 (queue already cleared)", () => {
    limiter = new AdaptiveRateLimiter()
    limiter.rejectQueued()
    const count = limiter.rejectQueued()
    expect(count).toBe(0)
  })
})
