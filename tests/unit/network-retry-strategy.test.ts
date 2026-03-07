import { describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"

import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"

/** Helper to create an ApiError for testing */
function makeApiError(overrides: Partial<ApiError> = {}): ApiError {
  return {
    type: "network_error",
    status: 0,
    message: "fetch failed",
    raw: new Error("fetch failed"),
    ...overrides,
  }
}

describe("createNetworkRetryStrategy", () => {
  test("can handle network_error", () => {
    const strategy = createNetworkRetryStrategy()
    const error = makeApiError({ type: "network_error" })
    expect(strategy.canHandle(error)).toBe(true)
  })

  test("cannot handle non-network errors", () => {
    const strategy = createNetworkRetryStrategy()

    expect(strategy.canHandle(makeApiError({ type: "auth_expired" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "server_error" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "rate_limited" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "bad_request" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "token_limit" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "content_filtered" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "quota_exceeded" }))).toBe(false)
    expect(strategy.canHandle(makeApiError({ type: "upstream_rate_limited" }))).toBe(false)
  })

  test("returns retry action with 1s delay", async () => {
    const strategy = createNetworkRetryStrategy<{ model: string }>()
    const error = makeApiError()
    const payload = { model: "test-model" }
    const context = { attempt: 0, maxRetries: 3, originalPayload: payload, model: undefined }

    const result = await strategy.handle(error, payload, context)

    expect(result.action).toBe("retry")
    if (result.action === "retry") {
      expect(result.payload).toBe(payload) // Same reference — no modification
      expect(result.waitMs).toBe(1000)
      expect(result.meta?.networkRetry).toBe(true)
    }
  })

  test("only retries once — second network error is not handled", async () => {
    const strategy = createNetworkRetryStrategy<{ model: string }>()
    const error = makeApiError()
    const payload = { model: "test-model" }
    const context = { attempt: 0, maxRetries: 3, originalPayload: payload, model: undefined }

    // First call: should handle
    expect(strategy.canHandle(error)).toBe(true)
    await strategy.handle(error, payload, context)

    // Second call: should NOT handle (already retried once)
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("has correct name", () => {
    const strategy = createNetworkRetryStrategy()
    expect(strategy.name).toBe("network-retry")
  })

  test("preserves payload without modification", async () => {
    const strategy = createNetworkRetryStrategy<{ model: string; messages: Array<string> }>()
    const error = makeApiError()
    const payload = { model: "claude-sonnet-4", messages: ["hello", "world"] }
    const context = { attempt: 0, maxRetries: 3, originalPayload: payload, model: undefined }

    const result = await strategy.handle(error, payload, context)

    if (result.action === "retry") {
      expect(result.payload).toBe(payload)
      expect(result.payload.model).toBe("claude-sonnet-4")
      expect(result.payload.messages).toEqual(["hello", "world"])
    }
  })
})
