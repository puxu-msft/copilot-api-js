import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import { AdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import {
  //
  AdaptiveUpstreamAdmissionController,
  type UpstreamAdmissionInput,
} from "~/lib/transport/admission-controller"

import { FakeClock } from "../helpers/fake-clock"

function admission(signal: AbortSignal, dispatchId = "dispatch-1"): UpstreamAdmissionInput {
  return {
    model: "claude-test",
    candidateId: "candidate-1",
    dispatchId,
    signal,
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

let clock: FakeClock | undefined

afterEach(() => {
  clock?.restore()
  clock = undefined
})

describe("AdaptiveUpstreamAdmissionController", () => {
  test("normal mode admits immediately with authoritative timing and never executes transport work", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter()
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const signal = new AbortController()

    const result = await controller.acquire(admission(signal.signal))

    expect(result).toEqual({ admittedAt: clock.now, queueWaitMs: 0 })
    expect(limiter.getStatus().mode).toBe("normal")
  })

  test("observe turns a 429 plus Retry-After into a retry decision without calling fetch", () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter()
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      throw new Error("observe must not fetch")
    }) as unknown as typeof fetch

    try {
      const decision = controller.observe({
        model: "claude-test",
        status: 429,
        retryAfterMs: 1_500,
        completedAt: clock.now,
      })

      expect(decision).toEqual({ kind: "retry", retryAfterMs: 1_500, retryAt: clock.now + 1_500 })
      expect(fetchCalls).toBe(0)
      expect(limiter.getStatus().mode).toBe("rate-limited")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("429 observations without Retry-After use capped exponential backoff", () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({ baseRetryIntervalSeconds: 0.1, maxRetryIntervalSeconds: 0.15 })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)

    expect(controller.observe({ model: "claude-test", status: 429, completedAt: clock.now })).toEqual({
      kind: "retry",
      retryAfterMs: 100,
      retryAt: clock.now + 100,
    })
    expect(controller.observe({ model: "claude-test", status: 429, completedAt: clock.now + 10 })).toEqual({
      kind: "retry",
      retryAfterMs: 150,
      retryAt: clock.now + 160,
    })
  })

  test("a post-429 acquire waits for Retry-After and reports queue wait/admission time", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({ requestIntervalSeconds: 0 })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const signal = new AbortController()

    controller.observe({ model: "claude-test", status: 429, retryAfterMs: 250, completedAt: clock.now })
    let settled = false
    const pending = controller.acquire(admission(signal.signal)).finally(() => {
      settled = true
    })
    await drainMicrotasks()

    expect(settled).toBe(false)
    await clock.advance(249)
    expect(settled).toBe(false)
    await clock.advance(1)

    await expect(pending).resolves.toEqual({ admittedAt: clock.now, queueWaitMs: 250 })
  })

  test("cancel during a queued Retry-After sleep removes only that admission", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({ requestIntervalSeconds: 0 })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const reason = new Error("candidate lost")

    controller.observe({ model: "claude-test", status: 429, retryAfterMs: 500, completedAt: clock.now })
    const first = controller.acquire(admission(firstAbort.signal, "dispatch-1"))
    const second = controller.acquire(admission(secondAbort.signal, "dispatch-2"))
    await drainMicrotasks()

    firstAbort.abort(reason)
    await expect(first).rejects.toBe(reason)
    await clock.advance(500)
    await expect(second).resolves.toEqual({ admittedAt: clock.now, queueWaitMs: 500 })
  })

  test("an already-aborted acquire rejects without entering the queue", async () => {
    const limiter = new AdaptiveRateLimiter()
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const abort = new AbortController()
    const reason = new Error("already cancelled")
    abort.abort(reason)

    await expect(controller.acquire(admission(abort.signal))).rejects.toBe(reason)
  })

  test("rejectAll rejects every queued admission with the exact shutdown reason", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({ requestIntervalSeconds: 0 })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)
    const shutdown = new Error("Server shutting down")

    controller.observe({ model: "claude-test", status: 429, retryAfterMs: 60_000, completedAt: clock.now })
    const first = controller.acquire(admission(new AbortController().signal, "dispatch-1"))
    const second = controller.acquire(admission(new AbortController().signal, "dispatch-2"))
    const firstObserved = first.then(
      () => undefined,
      (error: unknown) => error,
    )
    const secondObserved = second.then(
      () => undefined,
      (error: unknown) => error,
    )
    await drainMicrotasks()

    controller.rejectAll(shutdown)

    expect(await firstObserved).toBe(shutdown)
    expect(await secondObserved).toBe(shutdown)
  })

  test("successful observations drive rate-limited through recovering back to normal", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0,
      requestIntervalSeconds: 0,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [0, 0],
    })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)

    controller.observe({ model: "claude-test", status: 429, completedAt: clock.now })
    expect(limiter.getStatus().mode).toBe("rate-limited")

    await controller.acquire(admission(new AbortController().signal, "dispatch-retry"))
    expect(controller.observe({ model: "claude-test", completedAt: clock.now })).toEqual({ kind: "complete" })
    expect(limiter.getStatus().mode).toBe("rate-limited")
    expect(controller.observe({ model: "claude-test", status: 200, completedAt: clock.now })).toEqual({ kind: "complete" })
    expect(limiter.getStatus().mode).toBe("recovering")

    await controller.acquire(admission(new AbortController().signal, "dispatch-recovery-1"))
    controller.observe({ model: "claude-test", status: 200, completedAt: clock.now })
    expect(limiter.getStatus().mode).toBe("recovering")

    await controller.acquire(admission(new AbortController().signal, "dispatch-recovery-2"))
    controller.observe({ model: "claude-test", status: 204, completedAt: clock.now })
    expect(limiter.getStatus().mode).toBe("normal")
  })

  test("cancel interrupts recovering-mode pacing sleep", async () => {
    clock = new FakeClock()
    clock.install()
    const limiter = new AdaptiveRateLimiter({
      baseRetryIntervalSeconds: 0,
      requestIntervalSeconds: 0,
      consecutiveSuccessesForRecovery: 1,
      gradualRecoverySteps: [1, 1],
    })
    const controller = new AdaptiveUpstreamAdmissionController(limiter)

    controller.observe({ model: "claude-test", status: 429, completedAt: clock.now })
    await controller.acquire(admission(new AbortController().signal, "dispatch-retry"))
    controller.observe({ model: "claude-test", status: 200, completedAt: clock.now })
    expect(limiter.getStatus().mode).toBe("recovering")

    await controller.acquire(admission(new AbortController().signal, "dispatch-recovery-1"))
    const abort = new AbortController()
    const reason = new Error("loser cancelled during ramp-up")
    const sleeping = controller.acquire(admission(abort.signal, "dispatch-recovery-2"))
    await drainMicrotasks()
    abort.abort(reason)

    await expect(sleeping).rejects.toBe(reason)
  })
})
