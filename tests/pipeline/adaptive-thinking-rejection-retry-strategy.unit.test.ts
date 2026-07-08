import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { createAdaptiveThinkingRejectionRetryStrategy } from "~/lib/request/strategies/adaptive-thinking-rejection-retry"

interface TestPayload {
  model: string
  thinking?: { type?: string; display?: string | null; budget_tokens?: number } | null
  output_config?: { effort?: string; format?: unknown } | null
  [key: string]: unknown
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-haiku-4.5" },
  model: undefined,
}

const REJECTION = "adaptive thinking is not supported on this model"

function rejectionError(message = REJECTION): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ message }) },
  } as unknown as ApiError
}

describe("createAdaptiveThinkingRejectionRetryStrategy", () => {
  test("has the expected strategy name", () => {
    expect(createAdaptiveThinkingRejectionRetryStrategy<TestPayload>().name).toBe("adaptive-thinking-rejection-retry")
  })

  test("canHandle matches the adaptive-not-supported rejection", () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    expect(strategy.canHandle(rejectionError())).toBe(true)
  })

  test("canHandle returns false for the legacy enabled→adaptive rejection", () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const legacy = rejectionError('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive".')
    expect(strategy.canHandle(legacy)).toBe(false)
  })

  test("canHandle returns false for unrelated 400s", () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    expect(strategy.canHandle(rejectionError("Invalid request body"))).toBe(false)
  })

  test("canHandle returns false for non-400 errors", () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const err = { ...rejectionError(), type: "server_error", status: 500 } as unknown as ApiError
    expect(strategy.canHandle(err)).toBe(false)
  })

  test("handle rewrites adaptive→enabled and retries (default budget when no effort)", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5", thinking: { type: "adaptive" } }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("retry")
    // No effort → medium default budget (24576); adjustThinkingBudget clamps later.
    expect((result as { payload: TestPayload }).payload.thinking).toEqual({ type: "enabled", budget_tokens: 24576 })
    const meta = (result as { meta?: Record<string, unknown> }).meta
    expect(meta?.coercedEnabledThinking).toBe(true)
  })

  test("handle maps output_config.effort → budget_tokens (low/medium/high)", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const budgetFor = async (effort: string) => {
      const payload: TestPayload = { model: "claude-haiku-4.5", thinking: { type: "adaptive" }, output_config: { effort } }
      const result = await strategy.handle(rejectionError(), payload, retryContext)
      return ((result as { payload: TestPayload }).payload.thinking as { budget_tokens: number }).budget_tokens
    }
    expect(await budgetFor("low")).toBe(8192)
    expect(await budgetFor("medium")).toBe(24576)
    expect(await budgetFor("high")).toBe(32768)
  })

  test("handle drops output_config.effort but keeps other output_config fields", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-haiku-4.5",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema" } },
    }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect((result as { payload: TestPayload }).payload.output_config).toEqual({ format: { type: "json_schema" } })
  })

  test("handle removes output_config entirely when effort was its only field", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5", thinking: { type: "adaptive" }, output_config: { effort: "low" } }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect((result as { payload: TestPayload }).payload.output_config).toBeUndefined()
  })

  test("handle preserves display when rewriting", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5", thinking: { type: "adaptive", display: "omitted" } }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect((result as { payload: TestPayload }).payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 24576,
      display: "omitted",
    })
  })

  test("handle aborts when thinking is already enabled (no loop)", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5", thinking: { type: "enabled", budget_tokens: 8192 } }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("handle aborts when no thinking field", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5" }
    const result = await strategy.handle(rejectionError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("does not mutate the input payload", async () => {
    const strategy = createAdaptiveThinkingRejectionRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-haiku-4.5",
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    }
    await strategy.handle(rejectionError(), payload, retryContext)
    expect(payload.thinking).toEqual({ type: "adaptive", display: "omitted" })
    expect(payload.output_config).toEqual({ effort: "high" })
  })
})
