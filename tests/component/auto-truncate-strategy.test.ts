/**
 * Component tests for auto-truncate retry strategy.
 *
 * Tests: createAutoTruncateStrategy (canHandle + handle)
 */

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext, SanitizeResult } from "~/routes/shared/pipeline"
import type { TruncateOptions, TruncateResult } from "~/routes/shared/strategies/auto-truncate"

import { resetAllLimitsForTesting } from "~/lib/auto-truncate/common"
import { HTTPError } from "~/lib/error"
import { createAutoTruncateStrategy } from "~/routes/shared/strategies/auto-truncate"

import { mockModel } from "../helpers/factories"

type TestPayload = { messages: Array<{ role: string; content: string }> }

function makeStrategy(overrides?: {
  isEnabled?: () => boolean
  truncateResult?: Partial<TruncateResult<TestPayload>>
  sanitizeResult?: Partial<SanitizeResult<TestPayload>>
}) {
  const defaultPayload: TestPayload = { messages: [{ role: "user", content: "truncated" }] }

  const truncate = mock(
    async (_p: TestPayload, _m: any, _o: TruncateOptions): Promise<TruncateResult<TestPayload>> => ({
      wasTruncated: true,
      payload: defaultPayload,
      removedMessageCount: 2,
      originalTokens: 10000,
      compactedTokens: 5000,
      processingTimeMs: 50,
      ...overrides?.truncateResult,
    }),
  )

  const resanitize = mock(
    (payload: TestPayload): SanitizeResult<TestPayload> => ({
      payload,
      removedCount: 0,
      systemReminderRemovals: 0,
      ...overrides?.sanitizeResult,
    }),
  )

  const strategy = createAutoTruncateStrategy<TestPayload>({
    truncate,
    resanitize,
    isEnabled: overrides?.isEnabled ?? (() => true),
    label: "test",
  })

  return { strategy, truncate, resanitize }
}

function make413Error(): ApiError {
  const raw = new HTTPError("Too large", 413, "")
  return { type: "payload_too_large", status: 413, raw, message: "payload too large" }
}

function makeTokenLimitError(): ApiError {
  const body = JSON.stringify({
    error: { message: "prompt token count of 135355 exceeds the limit of 128000" },
  })
  const raw = new HTTPError("Token limit", 400, body)
  return { type: "token_limit", status: 400, raw, message: "token limit", tokenLimit: 128000, tokenCurrent: 135355 }
}

function makeContext(overrides?: Partial<RetryContext<TestPayload>>): RetryContext<TestPayload> {
  return {
    attempt: 0,
    originalPayload: { messages: [{ role: "user", content: "original" }] },
    model: mockModel("claude-sonnet-4"),
    maxRetries: 3,
    ...overrides,
  }
}

afterEach(() => {
  resetAllLimitsForTesting()
})

// ─── canHandle ───

describe("createAutoTruncateStrategy - canHandle", () => {
  test("returns false when isEnabled() returns false", () => {
    const { strategy } = makeStrategy({ isEnabled: () => false })
    expect(strategy.canHandle(make413Error())).toBe(false)
  })

  test("returns true for payload_too_large when enabled", () => {
    const { strategy } = makeStrategy()
    expect(strategy.canHandle(make413Error())).toBe(true)
  })

  test("returns true for token_limit when enabled", () => {
    const { strategy } = makeStrategy()
    expect(strategy.canHandle(makeTokenLimitError())).toBe(true)
  })

  test("returns false for rate_limited", () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "rate_limited",
      status: 429,
      raw: new HTTPError("Rate limited", 429, ""),
      message: "rate limited",
    }
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("returns false for server_error", () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "server_error",
      status: 500,
      raw: new HTTPError("Server error", 500, ""),
      message: "server error",
    }
    expect(strategy.canHandle(error)).toBe(false)
  })
})

// ─── handle ───

describe("createAutoTruncateStrategy - handle", () => {
  test("aborts when no model in context", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext({ model: undefined }))
    expect(result.action).toBe("abort")
  })

  test("aborts when raw error is not HTTPError", async () => {
    const { strategy } = makeStrategy()
    const error: ApiError = {
      type: "payload_too_large",
      status: 413,
      raw: new Error("not HTTPError"),
      message: "test",
    }
    const result = await strategy.handle(error, { messages: [] }, makeContext())
    expect(result.action).toBe("abort")
  })

  test("truncates from originalPayload (not current)", async () => {
    const { strategy, truncate } = makeStrategy()
    const original: TestPayload = { messages: [{ role: "user", content: "original long message" }] }
    const current: TestPayload = { messages: [{ role: "user", content: "current" }] }

    await strategy.handle(make413Error(), current, makeContext({ originalPayload: original }))

    expect(truncate).toHaveBeenCalledTimes(1)
    expect(truncate.mock.calls[0][0]).toBe(original)
  })

  test("aborts when truncation returns wasTruncated=false", async () => {
    const { strategy } = makeStrategy({
      truncateResult: { wasTruncated: false },
    })
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())
    expect(result.action).toBe("abort")
  })

  test("re-sanitizes truncated payload", async () => {
    const { strategy, resanitize } = makeStrategy()
    await strategy.handle(make413Error(), { messages: [] }, makeContext())
    expect(resanitize).toHaveBeenCalledTimes(1)
  })

  test("returns retry action with truncateResult in meta", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())

    expect(result.action).toBe("retry")
    if (result.action === "retry") {
      expect((result as any).meta!.truncateResult).toBeDefined()
      expect((result as any).meta!.truncateResult.wasTruncated).toBe(true)
    }
  })

  test("returns sanitization counts in meta", async () => {
    const { strategy } = makeStrategy({
      sanitizeResult: { removedCount: 2, systemReminderRemovals: 1 },
    })
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext())

    if (result.action === "retry") {
      expect((result as any).meta!.sanitization.removedCount).toBe(2)
      expect((result as any).meta!.sanitization.systemReminderRemovals).toBe(1)
    }
  })

  test("returns attempt number in meta", async () => {
    const { strategy } = makeStrategy()
    const result = await strategy.handle(make413Error(), { messages: [] }, makeContext({ attempt: 2 }))

    if (result.action === "retry") {
      expect((result as any).meta!.attempt).toBe(3) // attempt + 1
    }
  })
})
