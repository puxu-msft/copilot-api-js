import { afterEach, describe, expect, test } from "bun:test"

import { AdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { HTTPError } from "~/lib/error"

import { waitUntil } from "../helpers/wait-until"

// RC4: rejectQueued() (shutdown Phase 1) races an in-flight processQueue that has already picked
// a queued request and is sleeping the pre-execute interval. The old code kept a local `request`
// reference and, after the sleep aborted, still called `request.execute()` — running upstream work
// for a caller that rejectQueued had ALREADY rejected with "Server shutting down". Per-item
// ownership (a `cancelled` flag re-checked after the sleep) prevents the orphan execute.

describe("AdaptiveRateLimiter reject/execute race (RC4)", () => {
  let limiter: AdaptiveRateLimiter
  afterEach(() => {
    limiter?.rejectQueued()
  })

  test("a queued request rejected mid-sleep does NOT execute its upstream work", async () => {
    limiter = new AdaptiveRateLimiter({ requestIntervalSeconds: 10 })

    // First request 429s → rate-limited mode + lastRequestTime set (so the next queued request
    // sleeps the interval before executing, opening the reject window).
    let firstCall = 0
    const p1 = limiter
      .execute(async () => {
        firstCall++
        if (firstCall === 1) throw new HTTPError("Rate limited", 429, "")
        return "ok"
      })
      .catch((e: Error) => e)
    await waitUntil(() => limiter.getStatus().mode === "rate-limited", { label: "rate-limited mode" })

    // Second request: its execute must NOT run if rejected during the pre-execute sleep.
    let executed = 0
    const p2 = limiter
      .execute(async () => {
        executed++
        return "should-not-run"
      })
      .catch((e: Error) => e)
    await waitUntil(() => limiter.getStatus().queueLength > 0, { label: "second request queued + sleeping" })

    // Reject while processQueue is sleeping the 10s interval.
    limiter.rejectQueued()

    // The caller is rejected…
    const r2 = await p2
    expect(r2).toBeInstanceOf(Error)
    expect((r2 as Error).message).toMatch(/shutting down/i)
    // …and — the decisive assertion — the upstream work never ran.
    await new Promise((r) => setTimeout(r, 30))
    expect(executed).toBe(0)

    void p1
  })
})
