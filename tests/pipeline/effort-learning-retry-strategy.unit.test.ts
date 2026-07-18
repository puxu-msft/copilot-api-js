/**
 * Unit tests for the effort-learning retry strategy (v4 P0.4).
 *
 * The strategy is the pipeline-driven replacement for the Anthropic client's
 * old 2-attempt `invalid_reasoning_effort` inner loop: on the upstream 400 it
 * learns the supported efforts (into the negotiation cache) and retries once;
 * re-preparation then clamps the effort to a supported value.
 *
 * `learn` is injected so these tests don't mutate the global negotiation cache
 * (no fs I/O, no `mock.module`) — the real `learnEffortsFromError` is covered by
 * the request-preparation tests.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/retry-types"

import { HTTPError } from "~/lib/error"
import { createEffortLearningRetryStrategy } from "~/lib/request/strategies/effort-learning-retry"

interface TestPayload {
  model: string
  [key: string]: unknown
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: { model: "claude-opus-4.7" },
  model: undefined,
}

const EFFORT_BODY = JSON.stringify({
  error: { message: 'output_config.effort "high" is not supported by model claude-opus-4.7; supported values: [medium]', code: "invalid_reasoning_effort" },
})

/** Build a bad_request ApiError whose raw HTTPError carries the given body. */
function effortError(body = EFFORT_BODY): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: "HTTP 400: Failed to create Anthropic messages",
    raw: new HTTPError("Failed to create Anthropic messages", 400, body, "claude-opus-4.7"),
  }
}

describe("createEffortLearningRetryStrategy", () => {
  test("has the expected strategy name", () => {
    expect(createEffortLearningRetryStrategy<TestPayload>().name).toBe("effort-learning")
  })

  test("canHandle matches invalid_reasoning_effort 400", () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    expect(strategy.canHandle(effortError())).toBe(true)
  })

  test("canHandle returns false for unrelated 400s", () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    expect(strategy.canHandle(effortError(JSON.stringify({ error: { message: "Extra inputs are not permitted" } })))).toBe(false)
  })

  test("canHandle returns false for non-400 errors", () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    expect(strategy.canHandle({ ...effortError(), type: "server_error", status: 500 })).toBe(false)
  })

  test("canHandle returns false when raw is not an HTTPError (no body)", () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    expect(strategy.canHandle({ type: "bad_request", status: 400, message: "boom", raw: new Error("boom") })).toBe(false)
  })

  test("handle retries when learn succeeds (same payload — re-prep clamps the effort)", async () => {
    const learnedBodies: Array<string> = []
    const strategy = createEffortLearningRetryStrategy<TestPayload>({
      learn: (body) => {
        learnedBodies.push(body)
        return true
      },
    })
    const payload: TestPayload = { model: "claude-opus-4.7" }
    const result = await strategy.handle(effortError(), payload, retryContext)
    expect(result.action).toBe("retry")
    expect((result as { payload: TestPayload }).payload).toBe(payload)
    expect(learnedBodies).toEqual([EFFORT_BODY])
  })

  test("handle aborts when learn returns false (nothing learnable — no loop)", async () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => false })
    const result = await strategy.handle(effortError(), { model: "claude-opus-4.7" }, retryContext)
    expect(result.action).toBe("abort")
  })

  test("is one-shot — canHandle returns false after one handle (mirrors attempt===0)", async () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    expect(strategy.canHandle(effortError())).toBe(true)
    await strategy.handle(effortError(), { model: "claude-opus-4.7" }, retryContext)
    expect(strategy.canHandle(effortError())).toBe(false)
  })

  test("does not mutate the input payload", async () => {
    const strategy = createEffortLearningRetryStrategy<TestPayload>({ learn: () => true })
    const payload: TestPayload = { model: "claude-opus-4.7" }
    await strategy.handle(effortError(), payload, retryContext)
    expect(payload).toEqual({ model: "claude-opus-4.7" })
  })
})
