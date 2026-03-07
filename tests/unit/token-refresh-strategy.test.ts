import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import type { ApiError, ApiErrorType } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import * as tokenModule from "~/lib/token"

// ============================================================================
// Spy on getCopilotTokenManager (avoids mock.module cross-file pollution)
// ============================================================================

const mockRefresh = mock<() => Promise<{ token: string } | null>>()
const mockManager = { refresh: mockRefresh }
let returnManager = true
let spy: ReturnType<typeof spyOn>

beforeAll(() => {
  spy = spyOn(tokenModule, "getCopilotTokenManager").mockImplementation(() =>
    returnManager ? (mockManager as any) : null,
  )
})

afterAll(() => {
  spy.mockRestore()
})

// ============================================================================
// Helpers
// ============================================================================

function authExpiredError(status = 401): ApiError {
  return { type: "auth_expired", status, message: "Token expired", raw: undefined }
}

function otherError(type: ApiErrorType = "rate_limited", status = 429): ApiError {
  return { type, status, message: "Rate limited", raw: undefined }
}

const retryContext: RetryContext<unknown> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "test" },
  model: undefined,
}

// ============================================================================
// Tests
// ============================================================================

describe("createTokenRefreshStrategy", () => {
  beforeEach(() => {
    mockRefresh.mockReset()
    mockRefresh.mockResolvedValue({ token: "new-token" })
    returnManager = true
  })

  test("has name 'token-refresh'", () => {
    const strategy = createTokenRefreshStrategy()
    expect(strategy.name).toBe("token-refresh")
  })

  // ── canHandle ──

  test("canHandle returns true for auth_expired error", () => {
    const strategy = createTokenRefreshStrategy()
    expect(strategy.canHandle(authExpiredError())).toBe(true)
  })

  test("canHandle returns true for 403 auth_expired", () => {
    const strategy = createTokenRefreshStrategy()
    expect(strategy.canHandle(authExpiredError(403))).toBe(true)
  })

  test("canHandle returns false for non-auth_expired errors", () => {
    const strategy = createTokenRefreshStrategy()
    expect(strategy.canHandle(otherError("rate_limited", 429))).toBe(false)
    expect(strategy.canHandle(otherError("bad_request", 400))).toBe(false)
    expect(strategy.canHandle(otherError("server_error", 500))).toBe(false)
  })

  test("canHandle returns false after first handle (prevents double-refresh)", async () => {
    const strategy = createTokenRefreshStrategy()
    const payload = { model: "test" }

    expect(strategy.canHandle(authExpiredError())).toBe(true)
    await strategy.handle(authExpiredError(), payload, retryContext)
    expect(strategy.canHandle(authExpiredError())).toBe(false)
  })

  test("canHandle returns false after failed handle too", async () => {
    mockRefresh.mockResolvedValue(null)
    const strategy = createTokenRefreshStrategy()
    const payload = { model: "test" }

    expect(strategy.canHandle(authExpiredError())).toBe(true)
    await strategy.handle(authExpiredError(), payload, retryContext)
    expect(strategy.canHandle(authExpiredError())).toBe(false)
  })

  // ── handle ──

  test("handle returns retry with same payload on successful refresh", async () => {
    const strategy = createTokenRefreshStrategy()
    const payload = { model: "test", messages: [{ role: "user", content: "hi" }] }

    const result = await strategy.handle(authExpiredError(), payload, retryContext)

    expect(result.action).toBe("retry")
    expect((result as any).payload).toBe(payload)
    expect((result as any).meta).toEqual({ tokenRefreshed: true })
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  test("handle returns abort when refresh fails (returns null)", async () => {
    mockRefresh.mockResolvedValue(null)
    const strategy = createTokenRefreshStrategy()
    const payload = { model: "test" }
    const error = authExpiredError()

    const result = await strategy.handle(error, payload, retryContext)

    expect(result.action).toBe("abort")
    expect((result as any).error).toBe(error)
  })

  test("handle returns abort when no token manager available", async () => {
    returnManager = false
    const strategy = createTokenRefreshStrategy()
    const payload = { model: "test" }
    const error = authExpiredError()

    const result = await strategy.handle(error, payload, retryContext)

    expect(result.action).toBe("abort")
    expect((result as any).error).toBe(error)
  })

  // ── isolation ──

  test("each createTokenRefreshStrategy call has independent state", async () => {
    const strategy1 = createTokenRefreshStrategy()
    const strategy2 = createTokenRefreshStrategy()
    const payload = { model: "test" }

    await strategy1.handle(authExpiredError(), payload, retryContext)

    // strategy1 is exhausted, strategy2 should still work
    expect(strategy1.canHandle(authExpiredError())).toBe(false)
    expect(strategy2.canHandle(authExpiredError())).toBe(true)
  })
})
