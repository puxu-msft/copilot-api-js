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
  getUnsupportedServerToolTypes,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { createServerToolRejectionStrategy } from "~/lib/request/strategies/server-tool-rejection-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

interface TestPayload {
  model: string
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-3-5-sonnet" },
  model: undefined,
}

/** Web-search-not-supported 400, message-wrapped form (upstream text in error.message). */
function webSearchError(message = "The use of the web search tool is not supported."): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: `HTTP 400: ${message}`,
    raw: { responseText: JSON.stringify({ error: { message, code: "unsupported_value" } }) },
  } as unknown as ApiError
}

/** Same upstream error but the text lives ONLY in HTTPError.responseText (wrapper message generic). */
function webSearchErrorLaconic(): ApiError {
  const body = JSON.stringify({ error: { message: "The use of the web search tool is not supported.", code: "unsupported_value" } })
  return {
    type: "bad_request",
    status: 400,
    message: "HTTP 400: Failed to create Anthropic messages",
    raw: new HTTPError("Failed to create Anthropic messages", 400, body),
  } as unknown as ApiError
}

describe("createServerToolRejectionStrategy", () => {
  test("has the expected name", () => {
    expect(createServerToolRejectionStrategy<TestPayload>().name).toBe("server-tool-rejection-retry")
  })

  test("canHandle matches the web-search-not-supported 400 (message form)", () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(webSearchError())).toBe(true)
  })

  test("canHandle matches the web-search-not-supported 400 (HTTPError responseText form)", () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    expect(strategy.canHandle(webSearchErrorLaconic())).toBe(true)
  })

  test("canHandle ignores unrelated 400 errors", () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    const err = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: something else entirely",
      raw: { responseText: JSON.stringify({ error: { message: "nope" } }) },
    } as unknown as ApiError
    expect(strategy.canHandle(err)).toBe(false)
  })

  test("canHandle ignores a server-tool rejection NOT in the table (no speculative coverage)", () => {
    // A different server tool with an INVENTED rejection message. Only tools with
    // an OBSERVED upstream message earn a table row — this one must fall through
    // (return false) so it does not silently strip an unmodelled tool. Tests both
    // the message-wrapped and raw-responseText carriers (the two wire forms).
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    const message = "The use of the code execution tool is not supported."
    const messageForm = {
      type: "bad_request",
      status: 400,
      message: `HTTP 400: ${message}`,
      raw: { responseText: JSON.stringify({ error: { message, code: "unsupported_value" } }) },
    } as unknown as ApiError
    const rawForm = {
      type: "bad_request",
      status: 400,
      message: "HTTP 400: Failed to create Anthropic messages",
      raw: new HTTPError("Failed to create Anthropic messages", 400, JSON.stringify({ error: { message, code: "unsupported_value" } })),
    } as unknown as ApiError
    expect(strategy.canHandle(messageForm)).toBe(false)
    expect(strategy.canHandle(rawForm)).toBe(false)
  })

  test("canHandle ignores non-400 / non-bad_request errors", () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    const rateLimited = { type: "rate_limited", status: 429, message: "The use of the web search tool is not supported." } as unknown as ApiError
    const serverErr = { type: "bad_request", status: 500, message: "The use of the web search tool is not supported." } as unknown as ApiError
    expect(strategy.canHandle(rateLimited)).toBe(false)
    expect(strategy.canHandle(serverErr)).toBe(false)
  })

  test("handle marks the server tool unsupported and requests a retry with explicit hints", async () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-3-5-sonnet" }
    const action = await strategy.handle(webSearchError(), payload, retryContext)

    expect(action.action).toBe("retry")
    if (action.action !== "retry") return // type narrowing
    expect(action.payload).toBe(payload)
    expect(action.prepareHints?.excludeServerToolTypes).toEqual(["web_search_"])
    expect(action.meta?.strippedServerTools).toEqual(["web_search_"])
    expect(getUnsupportedServerToolTypes(payload.model)).toEqual(["web_search_"])
  })

  test("canHandle returns false after a handled attempt (one-shot guard against loops)", async () => {
    const strategy = createServerToolRejectionStrategy<TestPayload>()
    const payload: TestPayload = { model: "claude-3-5-sonnet" }
    expect(strategy.canHandle(webSearchError())).toBe(true)
    await strategy.handle(webSearchError(), payload, retryContext)
    expect(strategy.canHandle(webSearchError())).toBe(false)
  })

  test("per-instance state — a fresh strategy is not poisoned by a sibling's attempt", async () => {
    const a = createServerToolRejectionStrategy<TestPayload>()
    await a.handle(webSearchError(), { model: "claude-3-5-sonnet" }, retryContext)
    const b = createServerToolRejectionStrategy<TestPayload>()
    expect(b.canHandle(webSearchError())).toBe(true)
  })
})
