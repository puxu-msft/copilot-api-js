import { describe, expect, test } from "bun:test"

import { HTTPError, classifyError, parseTokenLimitError } from "~/lib/error"

describe("HTTPError", () => {
  test("should create error with status and response text", () => {
    const error = new HTTPError("Test error", 400, "Bad request")

    expect(error.message).toBe("Test error")
    expect(error.status).toBe(400)
    expect(error.responseText).toBe("Bad request")
    expect(error.modelId).toBeUndefined()
  })

  test("should create error with model ID", () => {
    const error = new HTTPError("Token limit", 400, '{"error":"too long"}', "claude-sonnet-4")

    expect(error.modelId).toBe("claude-sonnet-4")
    expect(error.status).toBe(400)
  })

  test("should create error from Response", async () => {
    const response = new Response("Server error body", { status: 500 })
    const error = await HTTPError.fromResponse("Server error", response, "gpt-4o")

    expect(error.status).toBe(500)
    expect(error.responseText).toBe("Server error body")
    expect(error.modelId).toBe("gpt-4o")
  })

  test("should be an instance of Error", () => {
    const error = new HTTPError("test", 400, "body")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(HTTPError)
  })
})

describe("Error message formats", () => {
  test("OpenAI token limit error format should be parseable", () => {
    // Test the format that parseTokenLimitError handles internally
    const openaiMessage = "prompt token count of 135355 exceeds the limit of 128000"
    const match = openaiMessage.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)

    expect(match).not.toBeNull()
    expect(Number.parseInt(match![1], 10)).toBe(135355)
    expect(Number.parseInt(match![2], 10)).toBe(128000)
  })

  test("Anthropic token limit error format should be parseable", () => {
    const anthropicMessage = "prompt is too long: 208598 tokens > 200000 maximum"
    const match = anthropicMessage.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)

    expect(match).not.toBeNull()
    expect(Number.parseInt(match![1], 10)).toBe(208598)
    expect(Number.parseInt(match![2], 10)).toBe(200000)
  })

  test("should not match unrelated error messages", () => {
    const unrelatedMessage = "Invalid API key"
    const openaiMatch = unrelatedMessage.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)
    const anthropicMatch = unrelatedMessage.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)

    expect(openaiMatch).toBeNull()
    expect(anthropicMatch).toBeNull()
  })
})

// ─── parseTokenLimitError (from characterization/retry-loop.test.ts) ───

describe("parseTokenLimitError", () => {
  test("parses OpenAI format", () => {
    const message = "prompt token count of 135355 exceeds the limit of 128000"
    const result = parseTokenLimitError(message)
    expect(result).not.toBeNull()
    expect(result!.current).toBe(135355)
    expect(result!.limit).toBe(128000)
  })

  test("parses Anthropic format", () => {
    const message = "prompt is too long: 208598 tokens > 200000 maximum"
    const result = parseTokenLimitError(message)
    expect(result).not.toBeNull()
    expect(result!.current).toBe(208598)
    expect(result!.limit).toBe(200000)
  })

  test("returns null for non-matching message", () => {
    expect(parseTokenLimitError("some random error")).toBeNull()
    expect(parseTokenLimitError("")).toBeNull()
    expect(parseTokenLimitError("token limit exceeded")).toBeNull()
  })

  test("handles messages embedded in larger text", () => {
    const message =
      "Error: The request failed because prompt token count of 135355 exceeds the limit of 128000 for model gpt-4o"
    const result = parseTokenLimitError(message)
    expect(result).not.toBeNull()
    expect(result!.current).toBe(135355)
    expect(result!.limit).toBe(128000)
  })
})

// ─── classifyError ───

describe("classifyError", () => {
  test("classifies HTTPError 429 as rate_limited", () => {
    const error = new HTTPError("Rate limited", 429, "{}")
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.status).toBe(429)
    expect(result.raw).toBe(error)
  })

  test("classifies HTTPError 413 as payload_too_large", () => {
    const error = new HTTPError("Too large", 413, "")
    const result = classifyError(error)
    expect(result.type).toBe("payload_too_large")
    expect(result.status).toBe(413)
  })

  test("classifies HTTPError 401 as auth_expired", () => {
    const error = new HTTPError("Unauthorized", 401, "")
    const result = classifyError(error)
    expect(result.type).toBe("auth_expired")
    expect(result.status).toBe(401)
  })

  test("classifies HTTPError 403 as auth_expired", () => {
    const error = new HTTPError("Forbidden", 403, "")
    const result = classifyError(error)
    expect(result.type).toBe("auth_expired")
    expect(result.status).toBe(403)
  })

  test("classifies HTTPError 5xx as server_error", () => {
    const error = new HTTPError("Server error", 500, "")
    expect(classifyError(error).type).toBe("server_error")

    const error502 = new HTTPError("Bad gateway", 502, "")
    expect(classifyError(error502).type).toBe("server_error")

    const error503 = new HTTPError("Service unavailable", 503, "")
    expect(classifyError(error503).type).toBe("server_error")
  })

  test("classifies HTTPError 400 as bad_request", () => {
    const error = new HTTPError("Bad request", 400, '{"error":{"message":"invalid param"}}')
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
    expect(result.status).toBe(400)
  })

  test("detects token limit error in 400 response body", () => {
    const body = JSON.stringify({
      error: {
        message: "prompt token count of 135355 exceeds the limit of 128000",
      },
    })
    const error = new HTTPError("Token limit", 400, body)
    const result = classifyError(error)
    expect(result.type).toBe("token_limit")
    expect(result.tokenLimit).toBe(128000)
    expect(result.tokenCurrent).toBe(135355)
  })

  test("extracts retryAfter from body retry_after field", () => {
    const body = JSON.stringify({ retry_after: 30 })
    const error = new HTTPError("Rate limited", 429, body)
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.retryAfter).toBe(30)
  })

  test("extracts retryAfter from nested error.retry_after", () => {
    const body = JSON.stringify({ error: { retry_after: 15 } })
    const error = new HTTPError("Rate limited", 429, body)
    const result = classifyError(error)
    expect(result.retryAfter).toBe(15)
  })

  test("detects rate_limited code in body as rate_limited", () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } })
    const error = new HTTPError("Bad request", 400, body)
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.status).toBe(400)
  })

  test("classifies TypeError with 'fetch' as network_error", () => {
    const error = new TypeError("fetch failed")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.status).toBe(0)
  })

  test("classifies generic Error as bad_request with status 0", () => {
    const error = new Error("Something went wrong")
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
    expect(result.status).toBe(0)
    expect(result.message).toBe("Something went wrong")
  })

  test("classifies non-Error as bad_request", () => {
    const result = classifyError("string error")
    expect(result.type).toBe("bad_request")
    expect(result.status).toBe(0)
    expect(result.message).toBe("string error")
  })

  test("preserves raw error reference", () => {
    const error = new HTTPError("test", 400, "")
    const result = classifyError(error)
    expect(result.raw).toBe(error)

    const genericError = new Error("test")
    const result2 = classifyError(genericError)
    expect(result2.raw).toBe(genericError)
  })

  test("defaults retryAfter to undefined for 429 with non-JSON body", () => {
    const error = new HTTPError("Rate limited", 429, "not json")
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.retryAfter).toBeUndefined()
  })
})
