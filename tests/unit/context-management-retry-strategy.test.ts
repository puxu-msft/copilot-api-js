import { afterEach, describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import {
  createContextManagementRetryStrategy,
  parseContextManagementExtraInputsError,
} from "~/lib/request/strategies/context-management-retry"
import {
  isAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"

afterEach(() => {
  resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
  context_management?: Record<string, unknown> | null
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4-6" },
  model: undefined,
}

function contextManagementError(message = "context_management: Extra inputs are not permitted"): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: {
      responseText: JSON.stringify({ error: { message } }),
    },
  } as unknown as ApiError
}

describe("parseContextManagementExtraInputsError", () => {
  test("matches the upstream extra-inputs error", () => {
    expect(parseContextManagementExtraInputsError("context_management: Extra inputs are not permitted")).toBe(true)
  })

  test("returns false for unrelated messages", () => {
    expect(parseContextManagementExtraInputsError("Invalid request body")).toBe(false)
  })
})

describe("createContextManagementRetryStrategy", () => {
  test("has the expected strategy name", () => {
    expect(createContextManagementRetryStrategy<TestPayload>().name).toBe("context-management-retry")
  })

  test("canHandle matches the context_management extra-inputs error", () => {
    const strategy = createContextManagementRetryStrategy<TestPayload>()
    expect(strategy.canHandle(contextManagementError())).toBe(true)
  })

  test("canHandle returns false for unrelated 400s", () => {
    const strategy = createContextManagementRetryStrategy<TestPayload>()
    const error = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: Invalid request",
      raw: {
        responseText: JSON.stringify({ error: { message: "Invalid request" } }),
      },
    } as unknown as ApiError
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("handle retries with explicit context_management disable sentinel", async () => {
    const strategy = createContextManagementRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-opus-4-6",
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    }

    const result = await strategy.handle(contextManagementError(), payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload.context_management).toBeNull()
    expect((result as { meta?: Record<string, unknown> }).meta).toEqual({ disabledContextManagement: true })
    expect(isAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")).toBe(true)
  })

  test("handle also retries when context_management was auto-injected upstream", async () => {
    const strategy = createContextManagementRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-6" }

    const result = await strategy.handle(contextManagementError(), payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload.context_management).toBeNull()
  })

  test("handle aborts if context_management is already disabled", async () => {
    const strategy = createContextManagementRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-6", context_management: null }

    const result = await strategy.handle(contextManagementError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })
})
