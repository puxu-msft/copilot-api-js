/**
 * Unit tests for auto-truncate common utilities.
 *
 * Split from: characterization/retry-loop.test.ts
 * Tests: tryParseAndLearnLimit, constants, limit learning
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  AUTO_TRUNCATE_RETRY_FACTOR,
  MAX_AUTO_TRUNCATE_RETRIES,
  getEffectiveByteLimitBytes,
  getEffectiveTokenLimit,
  resetAllLimitsForTesting,
  tryParseAndLearnLimit,
} from "~/lib/auto-truncate/common"
import { HTTPError } from "~/lib/error"

// ─── Constants ───

describe("auto-truncate constants", () => {
  test("MAX_AUTO_TRUNCATE_RETRIES is 5", () => {
    expect(MAX_AUTO_TRUNCATE_RETRIES).toBe(5)
  })

  test("AUTO_TRUNCATE_RETRY_FACTOR is 0.9", () => {
    expect(AUTO_TRUNCATE_RETRY_FACTOR).toBe(0.9)
  })
})

// ─── tryParseAndLearnLimit ───

describe("tryParseAndLearnLimit", () => {
  afterEach(() => {
    resetAllLimitsForTesting()
  })

  test("detects 413 as body_too_large", () => {
    const error = new HTTPError("Too large", 413, "")
    const result = tryParseAndLearnLimit(error, "test-model", 600000)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("body_too_large")
  })

  test("413 adjusts dynamic byte limit", () => {
    const error = new HTTPError("Too large", 413, "")
    tryParseAndLearnLimit(error, "test-model", 600000)

    const limit = getEffectiveByteLimitBytes()
    // Should be 90% of 600000 = 540000
    expect(limit).toBe(Math.max(Math.floor(600000 * 0.9), 100 * 1024))
  })

  test("detects 400 with token limit error (OpenAI format)", () => {
    const errorBody = JSON.stringify({
      error: {
        code: "model_max_prompt_tokens_exceeded",
        message: "prompt token count of 135355 exceeds the limit of 128000",
      },
    })
    const error = new HTTPError("Token limit", 400, errorBody)
    const result = tryParseAndLearnLimit(error, "gpt-4o")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("token_limit")
    expect(result!.current).toBe(135355)
    expect(result!.limit).toBe(128000)
  })

  test("detects 400 with token limit error (Anthropic format)", () => {
    const errorBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 208598 tokens > 200000 maximum",
      },
    })
    const error = new HTTPError("Token limit", 400, errorBody)
    const result = tryParseAndLearnLimit(error, "claude-sonnet-4-20250514")
    expect(result).not.toBeNull()
    expect(result!.type).toBe("token_limit")
    expect(result!.current).toBe(208598)
    expect(result!.limit).toBe(200000)
  })

  test("400 with token limit adjusts dynamic token limit", () => {
    const errorBody = JSON.stringify({
      error: {
        code: "model_max_prompt_tokens_exceeded",
        message: "prompt token count of 135355 exceeds the limit of 128000",
      },
    })
    const error = new HTTPError("Token limit", 400, errorBody)
    tryParseAndLearnLimit(error, "gpt-4o-test")

    const limit = getEffectiveTokenLimit("gpt-4o-test")
    // Should be 95% of 128000
    expect(limit).toBe(Math.floor(128000 * 0.95))
  })

  test("returns null for non-retryable errors (500)", () => {
    const error = new HTTPError("Server error", 500, "Internal Server Error")
    const result = tryParseAndLearnLimit(error, "test-model")
    expect(result).toBeNull()
  })

  test("returns null for 400 without token limit message", () => {
    const errorBody = JSON.stringify({
      error: {
        code: "invalid_api_key",
        message: "Invalid API key provided",
      },
    })
    const error = new HTTPError("Auth error", 400, errorBody)
    const result = tryParseAndLearnLimit(error, "test-model")
    expect(result).toBeNull()
  })

  test("returns null for 400 with non-JSON response", () => {
    const error = new HTTPError("Error", 400, "not json at all")
    const result = tryParseAndLearnLimit(error, "test-model")
    expect(result).toBeNull()
  })

  test("returns null for 429 (rate limit is not a limit error)", () => {
    const error = new HTTPError("Rate limited", 429, '{"error":{"code":"rate_limited"}}')
    const result = tryParseAndLearnLimit(error, "test-model")
    expect(result).toBeNull()
  })
})
