/**
 * Component tests for executeRequestPipeline.
 *
 * Uses mock adapters and strategies from helpers/ to test the
 * pipeline orchestration logic in isolation.
 */

import { describe, expect, mock, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryStrategy } from "~/routes/shared/pipeline"

import { HTTPError } from "~/lib/error"
import { executeRequestPipeline } from "~/routes/shared/pipeline"

import { createMockAdapter } from "../helpers/mock-adapter"
import { createMockStrategy, createRetryStrategy, createTypedStrategy } from "../helpers/mock-strategy"

type TestPayload = { data: string }

function makeApiError(type: ApiError["type"], status: number = 400): ApiError {
  const raw = new HTTPError("test", status, "")
  return { type, status, raw, message: "test error" }
}

// ─── Success path ───

describe("executeRequestPipeline - success path", () => {
  test("returns response on first success", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => ({ result: { content: "hello" }, queueWaitMs: 10 })),
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [],
      model: undefined,
    })

    expect(result.response).toEqual({ content: "hello" })
    expect(result.queueWaitMs).toBe(10)
    expect(result.totalRetries).toBe(0)
  })

  test("calls onBeforeAttempt before execution", async () => {
    const onBeforeAttempt = mock(() => {})
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => ({ result: "ok", queueWaitMs: 0 })),
    })

    await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [],
      model: undefined,
      onBeforeAttempt,
    })

    expect(onBeforeAttempt).toHaveBeenCalledTimes(1)
    expect(onBeforeAttempt).toHaveBeenCalledWith(0, { data: "test" })
  })
})

// ─── Retry path ───

describe("executeRequestPipeline - retry path", () => {
  test("retries with new payload from strategy", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async (_payload: TestPayload) => {
        callCount++
        if (callCount === 1) throw new HTTPError("Too large", 413, "")
        return { result: { ok: true }, queueWaitMs: 5 }
      }),
    })

    const strategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "truncated" },
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { data: "original" },
      originalPayload: { data: "original" },
      strategies: [strategy],
      model: undefined,
    })

    expect(result.response).toEqual({ ok: true })
    expect(result.totalRetries).toBe(1)
    expect(result.effectivePayload).toEqual({ data: "truncated" })
  })

  test("calls onRetry callback with strategy name and meta", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    })

    const strategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "new" },
      meta: { truncated: true },
    })

    const onRetry = mock(() => {})

    await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [strategy],
      model: undefined,
      onRetry,
    })

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(
      0,
      expect.stringContaining("typed-strategy"),
      { data: "new" },
      { truncated: true },
    )
  })

  test("accumulates queueWaitMs across retries (including waitMs)", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 20 }
      }),
    })

    const strategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "new" },
      waitMs: 100,
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [strategy],
      model: undefined,
    })

    // 100 (waitMs from strategy) + 20 (queueWaitMs from successful execute)
    expect(result.queueWaitMs).toBe(120)
  })

  test("skips strategies that cannot handle the error", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    })

    const unmatchedStrategy = createMockStrategy<TestPayload>({
      name: "unmatched",
      canHandle: mock(() => false),
    })

    const matchedStrategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "truncated" },
    })

    await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [unmatchedStrategy, matchedStrategy],
      model: undefined,
    })

    expect(unmatchedStrategy.canHandle).toHaveBeenCalled()
    expect(unmatchedStrategy.handle).not.toHaveBeenCalled()
  })

  test("tries strategies in order, uses first match", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    })

    const firstStrategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "from-first" },
    })

    const secondStrategy = createTypedStrategy<TestPayload>(["payload_too_large"], {
      action: "retry",
      payload: { data: "from-second" },
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { data: "test" },
      originalPayload: { data: "test" },
      strategies: [firstStrategy, secondStrategy],
      model: undefined,
    })

    expect(result.effectivePayload).toEqual({ data: "from-first" })
    expect(firstStrategy.handle).toHaveBeenCalledTimes(1)
    expect(secondStrategy.handle).not.toHaveBeenCalled()
  })
})

// ─── Failure path ───

describe("executeRequestPipeline - failure path", () => {
  test("stops retrying after maxRetries", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw new HTTPError("Too large", 413, "")
      }),
    })

    const strategy = createRetryStrategy<TestPayload>({ data: "truncated" })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [strategy],
        model: undefined,
        maxRetries: 2,
      }),
    ).rejects.toThrow()

    // 1 initial + 2 retries = 3 total calls
    expect(adapter.execute).toHaveBeenCalledTimes(3)
  })

  test("uses default maxRetries of 3", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw new HTTPError("Too large", 413, "")
      }),
    })

    const strategy = createRetryStrategy<TestPayload>({ data: "truncated" })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [strategy],
        model: undefined,
      }),
    ).rejects.toThrow()

    // 1 initial + 3 retries = 4 total calls
    expect(adapter.execute).toHaveBeenCalledTimes(4)
  })

  test("strategy returning abort stops retry", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        throw new HTTPError("Too large", 413, "")
      }),
    })

    const apiError = makeApiError("payload_too_large", 413)
    const strategy = createTypedStrategy<TestPayload>(["payload_too_large"], { action: "abort", error: apiError })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [strategy],
        model: undefined,
      }),
    ).rejects.toThrow()

    expect(callCount).toBe(1) // No retry
  })

  test("strategy throwing error stops retry", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        callCount++
        throw new HTTPError("Too large", 413, "")
      }),
    })

    const strategy: RetryStrategy<TestPayload> = {
      name: "throwing-strategy",
      canHandle: () => true,
      handle: async () => {
        throw new Error("Strategy internal failure")
      },
    }

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [strategy],
        model: undefined,
      }),
    ).rejects.toThrow()

    expect(callCount).toBe(1) // No retry
  })

  test("calls adapter.logPayloadSize on payload_too_large final failure", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw new HTTPError("Too large", 413, "")
      }),
    })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [],
        model: undefined,
      }),
    ).rejects.toThrow()

    expect(adapter.logPayloadSize).toHaveBeenCalled()
  })

  test("does not call logPayloadSize for non-413 errors", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw new Error("Network error")
      }),
    })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [],
        model: undefined,
      }),
    ).rejects.toThrow()

    expect(adapter.logPayloadSize).not.toHaveBeenCalled()
  })

  test("throws original error when no strategy handles it", async () => {
    const originalError = new HTTPError("Server error", 500, "")
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw originalError
      }),
    })

    try {
      await executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [],
        model: undefined,
      })
      expect(true).toBe(false) // Should not reach
    } catch (error) {
      expect(error).toBe(originalError)
    }
  })

  test("wraps non-Error exceptions in Error", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentionally testing non-Error throw handling
        throw "string error"
      }),
    })

    try {
      await executeRequestPipeline({
        adapter,
        payload: { data: "test" },
        originalPayload: { data: "test" },
        strategies: [],
        model: undefined,
      })
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })
})
