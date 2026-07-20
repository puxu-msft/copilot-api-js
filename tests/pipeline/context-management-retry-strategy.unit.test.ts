// Intentionally testing deprecated re-exports for back-compat.
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/retry-types"

import {
  //
  isAnthropicFeatureUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  createBodyFieldRejectionStrategy,
  createContextManagementRetryStrategy,
  parseContextManagementExtraInputsError,
  parseExtraInputsError,
} from "~/lib/request/strategies/context-management-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
  context_management?: Record<string, unknown> | null
  inference_geo?: string
  [key: string]: unknown
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4-6" },
  model: undefined,
}

function extraInputsError(message = "context_management: Extra inputs are not permitted"): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: {
      responseText: JSON.stringify({ error: { message } }),
    },
  } as unknown as ApiError
}

describe("parseExtraInputsError", () => {
  test("extracts the field name", () => {
    expect(parseExtraInputsError("context_management: Extra inputs are not permitted")?.field).toBe("context_management")
  })

  test("extracts non-context_management field names too", () => {
    expect(parseExtraInputsError("inference_geo: Extra inputs are not permitted")?.field).toBe("inference_geo")
  })

  test("returns null for unrelated messages", () => {
    expect(parseExtraInputsError("Invalid request body")).toBeNull()
  })

  // C1 regression: the tightened lookbehind must NOT claim a DOTTED sub-path
  // field (e.g. a rejected custom-tool field), which is not a top-level body
  // field — otherwise body-field-rejection would swallow the error before the
  // tool-field-rejection strategy (which CAN remediate the tools path) sees it.
  test("does NOT match a dotted tool-path field (C1)", () => {
    expect(parseExtraInputsError("tools.0.custom.eager_input_streaming: Extra inputs are not permitted")).toBeNull()
  })

  test("does NOT match a dotted nested message-path field (C1)", () => {
    expect(parseExtraInputsError("messages.5.content.0.foo: Extra inputs are not permitted")).toBeNull()
  })

  test("still matches a genuine top-level field even when other text precedes it", () => {
    expect(parseExtraInputsError('{"error":{"message":"context_management: Extra inputs are not permitted"}}')?.field).toBe("context_management")
  })
})

describe("parseContextManagementExtraInputsError (deprecated)", () => {
  test("matches only context_management variant", () => {
    expect(parseContextManagementExtraInputsError("context_management: Extra inputs are not permitted")).toBe(true)
    expect(parseContextManagementExtraInputsError("inference_geo: Extra inputs are not permitted")).toBe(false)
    expect(parseContextManagementExtraInputsError("Invalid request body")).toBe(false)
  })
})

describe("createBodyFieldRejectionStrategy", () => {
  test("has the expected strategy name", () => {
    expect(createBodyFieldRejectionStrategy<TestPayload>().name).toBe("body-field-rejection-retry")
  })

  test("createContextManagementRetryStrategy alias preserved", () => {
    expect(createContextManagementRetryStrategy).toBe(createBodyFieldRejectionStrategy)
  })

  test("canHandle matches any field's extra-inputs error", () => {
    const strategy = createBodyFieldRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(extraInputsError())).toBe(true)
    expect(strategy.canHandle(extraInputsError("inference_geo: Extra inputs are not permitted"))).toBe(true)
  })

  test("canHandle returns false for unrelated 400s", () => {
    const strategy = createBodyFieldRejectionStrategy<TestPayload>()
    const error = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: Invalid request",
      raw: { responseText: JSON.stringify({ error: { message: "Invalid request" } }) },
    } as unknown as ApiError
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("context_management: retry with explicit null sentinel + marks unsupported", async () => {
    const strategy = createBodyFieldRejectionStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "claude-opus-4-6",
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    }

    const result = await strategy.handle(extraInputsError(), payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload.context_management).toBeNull()
    const meta = (result as { meta?: Record<string, unknown> }).meta
    expect(meta?.rejectedField).toBe("context_management")
    expect(meta?.disabledContextManagement).toBe(true)
    expect(isAnthropicFeatureUnsupported("claude-opus-4-6", "context_management")).toBe(true)
    // C2 (review): the strategy must also surface the rejected field via the
    // explicit PrepareHints channel so retries don't rely solely on the
    // negotiation cache + prep re-read implicit contract.
    const prepareHints = (result as { prepareHints?: { rejectFields?: ReadonlyArray<string> } }).prepareHints
    expect(prepareHints?.rejectFields).toEqual(["context_management"])
  })

  test("context_management: aborts if already null", async () => {
    const strategy = createBodyFieldRejectionStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-6", context_management: null }

    const result = await strategy.handle(extraInputsError(), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("generic field: retry by deleting field + marks unsupported", async () => {
    const strategy = createBodyFieldRejectionStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4-6", inference_geo: "US" }

    const err = extraInputsError("inference_geo: Extra inputs are not permitted")
    const result = await strategy.handle(err, payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload.inference_geo).toBeUndefined()
    expect(isAnthropicFeatureUnsupported("claude-opus-4-6", "inference_geo")).toBe(true)
  })
})
