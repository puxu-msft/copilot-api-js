import { describe, expect, test } from "bun:test"

import {
  HTTPError,
  classifyError,
  forwardError,
  formatErrorWithCause,
  parseRetryAfterHeader,
  parseTokenLimitError,
} from "~/lib/error"

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

  test("should create error with responseHeaders", () => {
    const headers = new Headers({ "retry-after": "30", "x-custom": "value" })
    const error = new HTTPError("Rate limited", 429, "{}", undefined, headers)

    expect(error.responseHeaders).toBeDefined()
    expect(error.responseHeaders!.get("retry-after")).toBe("30")
    expect(error.responseHeaders!.get("x-custom")).toBe("value")
  })

  test("should capture headers from Response via fromResponse", async () => {
    const response = new Response("Too many requests", {
      status: 429,
      headers: { "retry-after": "60" },
    })
    const error = await HTTPError.fromResponse("Rate limited", response)

    expect(error.status).toBe(429)
    expect(error.responseHeaders).toBeDefined()
    expect(error.responseHeaders!.get("retry-after")).toBe("60")
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
  })

  test("classifies HTTPError 503 without rate limit body as server_error", () => {
    const error = new HTTPError("Service unavailable", 503, "")
    expect(classifyError(error).type).toBe("server_error")

    const error2 = new HTTPError("Maintenance", 503, '{"error":{"message":"Service is down"}}')
    expect(classifyError(error2).type).toBe("server_error")
  })

  test("classifies HTTPError 422 as content_filtered", () => {
    const error = new HTTPError("Content filtered", 422, '{"error":{"message":"Content blocked by RAI"}}')
    const result = classifyError(error)
    expect(result.type).toBe("content_filtered")
    expect(result.status).toBe(422)
  })

  test("classifies HTTPError 402 as quota_exceeded", () => {
    const error = new HTTPError("Quota exceeded", 402, "{}")
    const result = classifyError(error)
    expect(result.type).toBe("quota_exceeded")
    expect(result.status).toBe(402)
  })

  test("classifies HTTPError 402 with Retry-After header", () => {
    const headers = new Headers({ "retry-after": "3600" })
    const error = new HTTPError("Quota exceeded", 402, "{}", undefined, headers)
    const result = classifyError(error)
    expect(result.type).toBe("quota_exceeded")
    expect(result.retryAfter).toBe(3600)
  })

  test("classifies HTTPError 503 with upstream rate limit as upstream_rate_limited", () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded for upstream provider" } })
    const error = new HTTPError("Service unavailable", 503, body)
    const result = classifyError(error)
    expect(result.type).toBe("upstream_rate_limited")
    expect(result.status).toBe(503)
  })

  test("classifies HTTPError 503 with 'too many requests' as upstream_rate_limited", () => {
    const body = JSON.stringify({ error: { message: "Too many requests to the backend" } })
    const error = new HTTPError("Service unavailable", 503, body)
    const result = classifyError(error)
    expect(result.type).toBe("upstream_rate_limited")
  })

  test("classifies HTTPError 503 with rate limit code as upstream_rate_limited", () => {
    const body = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Try again later" } })
    const error = new HTTPError("Service unavailable", 503, body)
    const result = classifyError(error)
    expect(result.type).toBe("upstream_rate_limited")
  })

  test("429 with Retry-After header fallback when body has no retry_after", () => {
    const headers = new Headers({ "retry-after": "45" })
    const error = new HTTPError("Rate limited", 429, '{"error":{"code":"rate_limited"}}', undefined, headers)
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.retryAfter).toBe(45)
  })

  test("429 body retry_after takes priority over header", () => {
    const headers = new Headers({ "retry-after": "100" })
    const body = JSON.stringify({ retry_after: 30 })
    const error = new HTTPError("Rate limited", 429, body, undefined, headers)
    const result = classifyError(error)
    expect(result.type).toBe("rate_limited")
    expect(result.retryAfter).toBe(30)
  })

  test("quota_exceeded passes responseHeaders through to ApiError", () => {
    const headers = new Headers({ "x-quota-snapshot-chat": "ent=50&rem=0" })
    const error = new HTTPError("Quota exceeded", 402, "{}", undefined, headers)
    const result = classifyError(error)
    expect(result.responseHeaders).toBe(headers)
    expect(result.responseHeaders!.get("x-quota-snapshot-chat")).toBe("ent=50&rem=0")
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

  test("classifies socket closure (plain Error) as network_error", () => {
    const error = new Error("The socket connection was closed unexpectedly")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.status).toBe(0)
  })

  test("classifies ECONNRESET as network_error", () => {
    const error = new Error("read ECONNRESET")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  test("classifies ECONNREFUSED as network_error", () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:443")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  test("classifies ETIMEDOUT as network_error", () => {
    const error = new Error("connect ETIMEDOUT")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  test("classifies TLS error as network_error", () => {
    const error = new Error("TLS handshake failed")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  test("classifies error with network cause as network_error", () => {
    const cause = new Error("ECONNRESET")
    const error = new Error("request failed", { cause })
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
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

  test("strips Bun verbose hint from classifyError message", () => {
    const error = new Error(
      "The socket connection was closed unexpectedly. "
        + "For more information, pass `verbose: true` in the second argument to fetch()",
    )
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.message).toBe("The socket connection was closed unexpectedly.")
    expect(result.message).not.toContain("verbose")
  })

  test("includes cause in classifyError message", () => {
    const cause = new Error("connection reset by remote host")
    const error = new Error("The socket connection was closed unexpectedly", { cause })
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.message).toContain("cause: connection reset by remote host")
  })
})

// ─── formatErrorWithCause ───

describe("formatErrorWithCause", () => {
  test("returns message as-is for simple error", () => {
    const error = new Error("something broke")
    expect(formatErrorWithCause(error)).toBe("something broke")
  })

  test("strips Bun verbose hint", () => {
    const error = new Error(
      "The socket connection was closed unexpectedly. "
        + "For more information, pass `verbose: true` in the second argument to fetch()",
    )
    expect(formatErrorWithCause(error)).toBe("The socket connection was closed unexpectedly.")
  })

  test("appends cause message", () => {
    const cause = new Error("ECONNRESET")
    const error = new Error("request failed", { cause })
    expect(formatErrorWithCause(error)).toBe("request failed (cause: ECONNRESET)")
  })

  test("strips Bun verbose hint from cause too", () => {
    const cause = new Error(
      "TLS handshake failed. For more information, pass `verbose: true` in the second argument to fetch()",
    )
    const error = new Error("fetch error", { cause })
    expect(formatErrorWithCause(error)).toBe("fetch error (cause: TLS handshake failed.)")
  })

  test("does not duplicate when cause message equals parent message", () => {
    const cause = new Error("same message")
    const error = new Error("same message", { cause })
    expect(formatErrorWithCause(error)).toBe("same message")
  })

  test("ignores non-Error cause", () => {
    const error = new Error("something broke", { cause: "string cause" })
    expect(formatErrorWithCause(error)).toBe("something broke")
  })
})

// ─── parseRetryAfterHeader ───

describe("parseRetryAfterHeader", () => {
  test("parses integer seconds", () => {
    const headers = new Headers({ "retry-after": "120" })
    expect(parseRetryAfterHeader(headers)).toBe(120)
  })

  test("parses single second", () => {
    const headers = new Headers({ "retry-after": "1" })
    expect(parseRetryAfterHeader(headers)).toBe(1)
  })

  test("returns undefined for zero seconds", () => {
    const headers = new Headers({ "retry-after": "0" })
    expect(parseRetryAfterHeader(headers)).toBeUndefined()
  })

  test("returns undefined for negative seconds", () => {
    const headers = new Headers({ "retry-after": "-5" })
    expect(parseRetryAfterHeader(headers)).toBeUndefined()
  })

  test("parses HTTP-date in the future", () => {
    // Create a date 60 seconds from now
    const futureDate = new Date(Date.now() + 60_000)
    const headers = new Headers({ "retry-after": futureDate.toUTCString() })
    const result = parseRetryAfterHeader(headers)

    // Should be approximately 60, allowing for test execution time
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThanOrEqual(58)
    expect(result!).toBeLessThanOrEqual(62)
  })

  test("returns undefined for HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 60_000)
    const headers = new Headers({ "retry-after": pastDate.toUTCString() })
    expect(parseRetryAfterHeader(headers)).toBeUndefined()
  })

  test("returns undefined when header is missing", () => {
    const headers = new Headers()
    expect(parseRetryAfterHeader(headers)).toBeUndefined()
  })

  test("returns undefined when headers is undefined", () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined()
  })

  test("returns undefined for unparseable value", () => {
    const headers = new Headers({ "retry-after": "not-a-number-or-date" })
    expect(parseRetryAfterHeader(headers)).toBeUndefined()
  })
})

// ─── forwardError ───

describe("forwardError", () => {
  /** Create a minimal mock Hono Context for forwardError tests */
  function createMockContext(): {
    ctx: Parameters<typeof forwardError>[0]
    getLastJson: () => { data: unknown; status: number }
  } {
    let lastJson: { data: unknown; status: number } | undefined

    const ctx = {
      json: (data: unknown, status?: number) => {
        lastJson = { data, status: status ?? 200 }
        return new Response(JSON.stringify(data), { status: status ?? 200 })
      },
      req: {
        method: "POST",
        path: "/v1/messages",
      },
    } as unknown as Parameters<typeof forwardError>[0]

    return {
      ctx,
      getLastJson: () => {
        if (!lastJson) throw new Error("json() was never called")
        return lastJson
      },
    }
  }

  test("HTTPError 413 returns Anthropic-compatible request_too_large format", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Request too large", 413, ""))

    const { data, status } = getLastJson()
    expect(status).toBe(413)
    const body = data as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("Request body too large")
  })

  test("HTTPError 429 returns Anthropic-compatible rate_limit_error format", () => {
    const { ctx, getLastJson } = createMockContext()
    const responseBody = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } })
    forwardError(ctx, new HTTPError("Rate limited", 429, responseBody))

    const { data, status } = getLastJson()
    expect(status).toBe(429)
    const body = data as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toBe("Too many requests")
  })

  test("HTTPError 429 with non-JSON body still returns rate_limit_error", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Rate limited", 429, "plain text"))

    const { data, status } = getLastJson()
    expect(status).toBe(429)
    const body = data as { type: string; error: { type: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("rate_limit_error")
  })

  test("HTTPError 400 with token limit in body returns formatted error", () => {
    const { ctx, getLastJson } = createMockContext()
    const responseBody = JSON.stringify({
      error: { message: "prompt token count of 135355 exceeds the limit of 128000" },
    })
    forwardError(ctx, new HTTPError("Token limit", 400, responseBody, "claude-sonnet-4"))

    const { data, status } = getLastJson()
    expect(status).toBe(400)
    // forwardError returns error info; exact format depends on whether
    // tryParseAndLearnLimit detects the token limit pattern (requires state.autoTruncate)
    const body = data as Record<string, unknown>
    expect(body.error).toBeDefined()
  })

  test("HTTPError 400 without token limit returns generic error with original body", () => {
    const { ctx, getLastJson } = createMockContext()
    const responseBody = JSON.stringify({ error: { message: "Invalid parameter" } })
    forwardError(ctx, new HTTPError("Bad request", 400, responseBody))

    const { data, status } = getLastJson()
    expect(status).toBe(400)
    const body = data as { error: { message: string; type: string } }
    expect(body.error.type).toBe("error")
  })

  test("HTTPError 500 returns error with responseText", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Server error", 500, "Internal server error"))

    const { data, status } = getLastJson()
    expect(status).toBe(500)
    const body = data as { error: { message: string; type: string } }
    expect(body.error.message).toBe("Internal server error")
    expect(body.error.type).toBe("error")
  })

  test("non-HTTP Error returns 500 with error message", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new Error("unexpected failure"))

    const { data, status } = getLastJson()
    expect(status).toBe(500)
    const body = data as { error: { message: string; type: string } }
    expect(body.error.message).toBe("unexpected failure")
    expect(body.error.type).toBe("error")
  })

  test("non-Error value returns 500 with string representation", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, "string error value")

    const { data, status } = getLastJson()
    expect(status).toBe(500)
    const body = data as { error: { message: string; type: string } }
    expect(body.error.message).toBe("string error value")
    expect(body.error.type).toBe("error")
  })

  test("HTTPError 402 returns quota exceeded error", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Quota exceeded", 402, "{}"))

    const { data, status } = getLastJson()
    expect(status).toBe(402)
    const body = data as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("usage quota")
  })

  test("HTTPError 402 with Retry-After header includes retry_after", () => {
    const { ctx, getLastJson } = createMockContext()
    const headers = new Headers({ "retry-after": "3600" })
    forwardError(ctx, new HTTPError("Quota exceeded", 402, "{}", undefined, headers))

    const { data, status } = getLastJson()
    expect(status).toBe(402)
    const body = data as { type: string; retry_after?: number; error: { message: string } }
    expect(body.retry_after).toBe(3600)
    expect(body.error.message).toContain("3600 seconds")
  })

  test("HTTPError 422 returns content filtered error", () => {
    const { ctx, getLastJson } = createMockContext()
    const responseBody = JSON.stringify({ error: { message: "Content blocked by safety filter" } })
    forwardError(ctx, new HTTPError("Content filtered", 422, responseBody))

    const { data, status } = getLastJson()
    expect(status).toBe(422)
    const body = data as { type: string; error: { type: string; message: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("Content filtered")
    expect(body.error.message).toContain("Content blocked by safety filter")
  })

  test("HTTPError 422 with non-JSON body returns generic content filtered error", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Content filtered", 422, "not json"))

    const { data, status } = getLastJson()
    expect(status).toBe(422)
    const body = data as { type: string; error: { type: string; message: string } }
    expect(body.error.message).toBe("Content filtered by safety system")
  })

  test("HTTPError 503 with upstream rate limit returns rate_limit_error", () => {
    const { ctx, getLastJson } = createMockContext()
    const body = JSON.stringify({ error: { message: "Rate limit exceeded for upstream provider" } })
    forwardError(ctx, new HTTPError("Service unavailable", 503, body))

    const { data, status } = getLastJson()
    expect(status).toBe(503)
    const result = data as { type: string; error: { type: string; message: string } }
    expect(result.type).toBe("error")
    expect(result.error.type).toBe("rate_limit_error")
    expect(result.error.message).toContain("Rate limit exceeded")
  })

  test("HTTPError 503 without upstream rate limit returns generic error", () => {
    const { ctx, getLastJson } = createMockContext()
    forwardError(ctx, new HTTPError("Service unavailable", 503, "Service is down"))

    const { data, status } = getLastJson()
    expect(status).toBe(503)
    const body = data as { error: { message: string; type: string } }
    // Generic 503 — falls through to the default error handler
    expect(body.error.type).toBe("error")
  })
})
