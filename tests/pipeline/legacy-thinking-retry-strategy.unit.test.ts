import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { createLegacyThinkingRetryStrategy } from "~/lib/request/strategies/legacy-thinking-retry"

interface TestPayload {
  model: string
  thinking?: { type?: string; display?: string | null; budget_tokens?: number } | null
  [key: string]: unknown
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4-7" },
  model: undefined,
}

const REJECTION =
  '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'

function rejectionError(message = REJECTION): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ error: { message } }) },
  } as unknown as ApiError
}

describe("createLegacyThinkingRetryStrategy", () => {
  test("has the expected strategy name", () => {
    expect(createLegacyThinkingRetryStrategy<TestPayload>().name).toBe("legacy-thinking-retry")
  })

  test("canHandle matches the adaptive-only rejection", () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    expect(strategy.canHandle(rejectionError())).toBe(true)
  })

  test("canHandle returns false for unrelated 400s", () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    expect(strategy.canHandle(rejectionError("Invalid request body"))).toBe(false)
  })

  test("canHandle returns false for non-400 errors", () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const err = { ...rejectionError(), type: "server_error", status: 500 } as unknown as ApiError
    expect(strategy.canHandle(err)).toBe(false)
  })

  test("handle rewrites enabled→adaptive and retries", async () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 10000 },
    }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload.thinking).toEqual({ type: "adaptive" })
    const meta = (result as { meta?: Record<string, unknown> }).meta
    expect(meta?.coercedAdaptiveThinking).toBe(true)
  })

  test("handle preserves display when rewriting", async () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 10000, display: "omitted" },
    }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect((result as { payload: TestPayload }).payload.thinking).toEqual({ type: "adaptive", display: "omitted" })
  })

  test("handle aborts when thinking is already adaptive (no loop)", async () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-7", thinking: { type: "adaptive" } }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("handle aborts when no thinking field", async () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-7" }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("does not mutate the input payload", async () => {
    const strategy = createLegacyThinkingRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-7", thinking: { type: "enabled", budget_tokens: 10000 } }
    await strategy.handle(rejectionError(), payload, retryContext)
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })
})
