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
  isAnthropicBetaUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  createUnsupportedBetaRetryStrategy,
  parseUnsupportedBetas,
} from "~/lib/request/strategies/unsupported-beta-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4.7-1m-internal" },
  model: undefined,
}

function unsupportedBetaError(message = "unsupported beta header(s): context-1m-2025-08-07"): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ error: { message } }) },
  } as unknown as ApiError
}

describe("parseUnsupportedBetas", () => {
  test("extracts a single beta token", () => {
    expect(parseUnsupportedBetas("unsupported beta header(s): context-1m-2025-08-07")).toEqual([
      "context-1m-2025-08-07",
    ])
  })

  test("extracts multiple beta tokens", () => {
    expect(parseUnsupportedBetas("unsupported beta header(s): a, b, c")).toEqual(["a", "b", "c"])
  })

  test("returns empty for unrelated messages", () => {
    expect(parseUnsupportedBetas("Invalid request body")).toEqual([])
  })
})

describe("createUnsupportedBetaRetryStrategy", () => {
  test("has the expected name", () => {
    expect(createUnsupportedBetaRetryStrategy<TestPayload>().name).toBe("unsupported-beta-retry")
  })

  test("canHandle matches unsupported-beta errors", () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    expect(strategy.canHandle(unsupportedBetaError())).toBe(true)
  })

  test("canHandle ignores unrelated 400 errors", () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    const err = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: something else",
      raw: {},
    } as unknown as ApiError
    expect(strategy.canHandle(err)).toBe(false)
  })

  test("handle marks each beta unsupported and requests a retry", async () => {
    const strategy = createUnsupportedBetaRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-opus-4.7-1m-internal" }
    const action = await strategy.handle(
      unsupportedBetaError("unsupported beta header(s): context-1m-2025-08-07, foo"),
      payload,
      retryContext,
    )
    expect(action.action).toBe("retry")
    expect(isAnthropicBetaUnsupported(payload.model, "context-1m-2025-08-07")).toBe(true)
    expect(isAnthropicBetaUnsupported(payload.model, "foo")).toBe(true)
    expect(isAnthropicBetaUnsupported(payload.model, "unrelated")).toBe(false)
  })

  test("retry action carries explicit prepareHints.excludeBetas (H4 regression guard)", async () => {
    // H4: previously the strategy only mutated the global negotiation cache,
    // relying on the adapter to re-prepare and re-read it on the next attempt.
    // That contract was implicit and easy to break by any future adapter
    // memoization. The fix returns an authoritative `prepareHints` payload
    // that flows through the pipeline → adapter → prepare without depending
    // on the cache existing or being read.
    const strategy = createUnsupportedBetaRetryStrategy<{ model: string }>()
    const payload = { model: "claude-opus-4.6" }
    const action = await strategy.handle(
      unsupportedBetaError("unsupported beta header(s): context-1m-2025-08-07, foo"),
      payload,
      retryContext,
    )
    expect(action.action).toBe("retry")
    if (action.action !== "retry") return // type narrowing
    expect(action.prepareHints).toBeDefined()
    expect(action.prepareHints?.excludeBetas).toEqual(["context-1m-2025-08-07", "foo"])
  })
})
