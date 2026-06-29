import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"

import { mockApiError } from "../helpers/factories"

describe("createServerErrorRetryStrategy", () => {
  const ctx = <T>(payload: T) => ({ attempt: 0, maxRetries: 3, originalPayload: payload, model: undefined })

  test("can handle server_error (5xx)", () => {
    const strategy = createServerErrorRetryStrategy()
    expect(strategy.canHandle(mockApiError("server_error"))).toBe(true)
  })

  test("cannot handle non-server errors", () => {
    const strategy = createServerErrorRetryStrategy()

    expect(strategy.canHandle(mockApiError("network_error"))).toBe(false)
    expect(strategy.canHandle(mockApiError("auth_expired"))).toBe(false)
    expect(strategy.canHandle(mockApiError("rate_limited"))).toBe(false)
    expect(strategy.canHandle(mockApiError("bad_request"))).toBe(false)
    expect(strategy.canHandle(mockApiError("upstream_rate_limited"))).toBe(false)
  })

  test("returns retry action with exponential backoff", async () => {
    const strategy = createServerErrorRetryStrategy<{ model: string }>()
    const error = mockApiError("server_error")
    const payload = { model: "test-model" }

    const first = await strategy.handle(error, payload, ctx(payload))
    expect(first.action).toBe("retry")
    if (first.action === "retry") {
      expect(first.payload).toBe(payload)
      expect(first.waitMs).toBe(1000)
      expect(first.meta?.serverErrorRetry).toBe(true)
    }

    const second = await strategy.handle(error, payload, ctx(payload))
    if (second.action === "retry") expect(second.waitMs).toBe(2000)
  })

  test("retries at most twice then stops handling", async () => {
    const strategy = createServerErrorRetryStrategy<{ model: string }>()
    const error = mockApiError("server_error")
    const payload = { model: "test-model" }

    expect(strategy.canHandle(error)).toBe(true)
    await strategy.handle(error, payload, ctx(payload))
    expect(strategy.canHandle(error)).toBe(true)
    await strategy.handle(error, payload, ctx(payload))
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("has correct name", () => {
    expect(createServerErrorRetryStrategy().name).toBe("server-error-retry")
  })
})
