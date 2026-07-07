import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import {
  //
  getUnsupportedToolFields,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import {
  //
  createToolFieldRejectionStrategy,
  parseRejectedToolFields,
} from "~/lib/request/strategies/tool-field-rejection-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-haiku-4.5" },
  model: undefined,
}

/** Tool-field "Extra inputs" 400 with the upstream text in error.message. */
function toolFieldError(message = "tools.0.custom.eager_input_streaming: Extra inputs are not permitted"): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ error: { message } }) },
  } as unknown as ApiError
}

/** Same rejection but the text lives ONLY in HTTPError.responseText. */
function toolFieldErrorLaconic(inner = "tools.0.custom.eager_input_streaming: Extra inputs are not permitted"): ApiError {
  const body = JSON.stringify({ error: { message: inner } })
  return {
    type: "bad_request",
    status: 400,
    message: "HTTP 400: Failed to create messages",
    raw: new HTTPError("Failed to create messages", 400, body),
  } as unknown as ApiError
}

describe("parseRejectedToolFields", () => {
  test("extracts a single unknown top-level tool field", () => {
    expect(parseRejectedToolFields(toolFieldError())).toEqual(["eager_input_streaming"])
  })

  test("reads from HTTPError.responseText when the wrapped message is generic", () => {
    expect(parseRejectedToolFields(toolFieldErrorLaconic())).toEqual(["eager_input_streaming"])
  })

  test("H1: parses ALL offending fields in one response (matchAll, deduped)", () => {
    const msg =
      "tools.0.custom.eager_input_streaming: Extra inputs are not permitted; "
      + "tools.3.custom.some_new_field: Extra inputs are not permitted; "
      + "tools.7.custom.eager_input_streaming: Extra inputs are not permitted"
    expect(parseRejectedToolFields(toolFieldError(msg))).toEqual(["eager_input_streaming", "some_new_field"])
  })

  test("M3: tolerates a variant segment containing digits", () => {
    expect(parseRejectedToolFields(toolFieldError("tools.0.custom_20250101.weird_field: Extra inputs are not permitted"))).toEqual(["weird_field"])
  })

  test("deny guard: a LEGIT tool key is NOT claimed (variant-misrouting signal → null)", () => {
    // `input_schema` is a key GHC legitimately models — reporting it as "extra"
    // signals a misrouting bug, not an unknown field. Must return null so the
    // request fails loudly rather than silently stripping a legitimate field.
    expect(parseRejectedToolFields(toolFieldError("tools.0.custom.input_schema: Extra inputs are not permitted"))).toBeNull()
  })

  test("deny guard: mixes — strips the unknown field, ignores the legit one", () => {
    const msg = "tools.0.custom.cache_control: Extra inputs are not permitted; tools.1.custom.eager_input_streaming: Extra inputs are not permitted"
    expect(parseRejectedToolFields(toolFieldError(msg))).toEqual(["eager_input_streaming"])
  })

  test("does NOT match a deeper-nested field path (only top-level tool fields)", () => {
    expect(parseRejectedToolFields(toolFieldError("tools.0.custom.input_schema.properties.foo: Extra inputs are not permitted"))).toBeNull()
  })

  test("returns null for a non-tool 'Extra inputs' error (body field)", () => {
    expect(parseRejectedToolFields(toolFieldError("context_management: Extra inputs are not permitted"))).toBeNull()
  })

  test("returns null for unrelated errors", () => {
    expect(parseRejectedToolFields(toolFieldError("something else entirely"))).toBeNull()
  })
})

describe("createToolFieldRejectionStrategy", () => {
  test("has the expected name", () => {
    expect(createToolFieldRejectionStrategy<TestPayload>().name).toBe("tool-field-rejection-retry")
  })

  test("canHandle matches the tool-field 400 (both wire forms)", () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(toolFieldError())).toBe(true)
    expect(strategy.canHandle(toolFieldErrorLaconic())).toBe(true)
  })

  test("canHandle ignores a legit-key rejection (deny guard)", () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(toolFieldError("tools.0.custom.name: Extra inputs are not permitted"))).toBe(false)
  })

  test("canHandle ignores non-400 / non-bad_request errors", () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    const rateLimited = { type: "rate_limited", status: 429, message: toolFieldError().message } as unknown as ApiError
    const serverErr = { type: "bad_request", status: 500, message: toolFieldError().message } as unknown as ApiError
    expect(strategy.canHandle(rateLimited)).toBe(false)
    expect(strategy.canHandle(serverErr)).toBe(false)
  })

  test("handle marks fields endpoint-wide and retries with explicit hints", async () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-haiku-4.5" }
    const action = await strategy.handle(toolFieldError(), payload, retryContext)

    expect(action.action).toBe("retry")
    if (action.action !== "retry") return // type narrowing
    expect(action.payload).toBe(payload)
    expect(action.prepareHints?.excludeToolFields).toEqual(["eager_input_streaming"])
    expect(action.meta?.strippedToolFields).toEqual(["eager_input_streaming"])
    // Endpoint-level (model-agnostic): visible without a model argument.
    expect(getUnsupportedToolFields()).toEqual(["eager_input_streaming"])
  })

  test("M1: learned field is endpoint-wide — a DIFFERENT model sees it too", async () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    await strategy.handle(toolFieldError(), { model: "claude-haiku-4.5" }, retryContext)
    // getUnsupportedToolFields takes NO model — one 400 immunizes every model.
    expect(getUnsupportedToolFields()).toContain("eager_input_streaming")
  })

  test("one-shot guard: canHandle returns false after a handled attempt", async () => {
    const strategy = createToolFieldRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(toolFieldError())).toBe(true)
    await strategy.handle(toolFieldError(), { model: "claude-haiku-4.5" }, retryContext)
    expect(strategy.canHandle(toolFieldError())).toBe(false)
  })

  test("per-instance state — a fresh strategy is not poisoned by a sibling's attempt", async () => {
    const a = createToolFieldRejectionStrategy<TestPayload>()
    await a.handle(toolFieldError(), { model: "claude-haiku-4.5" }, retryContext)
    const b = createToolFieldRejectionStrategy<TestPayload>()
    expect(b.canHandle(toolFieldError())).toBe(true)
  })
})
