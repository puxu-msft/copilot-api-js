import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  HTTPError,
  classifyError,
  forwardError,
  formatErrorWithCause,
  mapHttpErrorToEnvelope,
  parseRetryAfterHeader,
  parseTokenLimitError,
} from "~/lib/error"
import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { tagTransportError } from "~/lib/error/transport-reason"

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
    const message = "Error: The request failed because prompt token count of 135355 exceeds the limit of 128000 for model gpt-4o"
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

  test.each(["", "   \n\t  "])("classifies HTTPError 499 with an empty body as network_error", (body) => {
    const headers = new Headers({ "x-github-request-id": "request-id" })
    const error = new HTTPError("Client Closed Request", 499, body, undefined, headers)
    const result = classifyError(error)

    expect(result.type).toBe("network_error")
    expect(result.status).toBe(499)
    expect(result.responseHeaders).toBe(headers)
    expect(result.raw).toBe(error)
  })

  test("keeps HTTPError 499 with a non-empty body as bad_request", () => {
    const error = new HTTPError("Client Closed Request", 499, '{"error":"cancelled"}')
    const result = classifyError(error)

    expect(result.type).toBe("bad_request")
    expect(result.status).toBe(499)
  })

  test("classifies GHC HTTP 408 request-body read timeout as network_error", () => {
    const headers = new Headers({ "x-github-request-id": "request-id" })
    const body = JSON.stringify({
      error: {
        code: "user_request_timeout",
        message: "Timed out reading request body. Try again, or use a smaller request size.",
      },
    })
    const error = new HTTPError("Failed to create responses", 408, body, undefined, headers)
    const result = classifyError(error)

    expect(result.type).toBe("network_error")
    expect(result.status).toBe(408)
    expect(result.responseHeaders).toBe(headers)
    expect(result.raw).toBe(error)
  })

  test.each([
    ["ordinary 408", '{"error":{"code":"request_timeout","message":"Request deadline exceeded"}}'],
    ["matching code with another message", '{"error":{"code":"user_request_timeout","message":"Generation timed out"}}'],
    ["matching message with another code", '{"error":{"code":"invalid_request","message":"Timed out reading request body."}}'],
    ["plain-text body", "Timed out reading request body."],
    ["malformed JSON body", '{"error":'],
    ["missing error object", '{"code":"user_request_timeout","message":"Timed out reading request body."}'],
    ["non-string message", '{"error":{"code":"user_request_timeout","message":408}}'],
  ])("keeps %s as bad_request", (_label, body) => {
    const result = classifyError(new HTTPError("Request timeout", 408, body))

    expect(result.type).toBe("bad_request")
    expect(result.status).toBe(408)
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

  // HTTP/2 REFUSED_STREAM: the peer refused the stream before ANY application
  // processing (RFC 9113 §5.1.2/§8.7 — safe to retry, even for non-idempotent POST).
  // Message strings below are the EXACT wire form, empirically confirmed on both Node
  // v24 and Bun v1.3 h2 clients (see exp/http2-refused-retry/report.md).
  test("classifies http2 NGHTTP2_REFUSED_STREAM as network_error", () => {
    const error = new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.status).toBe(0)
  })

  test("classifies http2 REFUSED_STREAM wrapped in cause as network_error", () => {
    const cause = new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM")
    const error = new Error("upstream request failed", { cause })
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  // Guard the precise scope: only REFUSED carries the "zero processing" guarantee.
  // NGHTTP2_CANCEL / NGHTTP2_INTERNAL_ERROR (real Bun samples, same report) may have
  // been processed → must NOT be reclassified as retryable network errors.
  test("does NOT reclassify http2 NGHTTP2_CANCEL as network_error (stays bad_request)", () => {
    const error = new Error("Stream closed with error code NGHTTP2_CANCEL")
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
  })

  test("does NOT reclassify http2 NGHTTP2_INTERNAL_ERROR as network_error (stays bad_request)", () => {
    const error = new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR")
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
  })

  // HTTP/2 pre-response teardown: the connection died before ANY response header
  // (status 0, zero frames — http2-client.ts's `!headersReceived` close backstop).
  // Reconnect-and-resend is the only path to a usable response → retryable
  // (network_error). WEAKER than REFUSED (no protocol guarantee) but kept as a
  // separate token list. Message strings are the EXACT wire form emitted by
  // http2-client.ts. See docs/plan/2026-07-22-h2-pool-capacity-routing-and-pre-response-retry.md.
  test("classifies http2 pre-response close (rstCode=0) as network_error", () => {
    const error = new Error("[http2] upstream stream closed before any response (rstCode=0)")
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
    expect(result.status).toBe(0)
  })

  test("classifies http2 pre-response close wrapped in cause as network_error", () => {
    const cause = new Error("[http2] upstream stream closed before any response (rstCode=0)")
    const error = new Error("upstream request failed", { cause })
    const result = classifyError(error)
    expect(result.type).toBe("network_error")
  })

  // Boundary guard (verified substring non-overlap): the mid-body truncation
  // "closed before end" is POST-headers — it must stay a body-stream error, NOT
  // be re-classified as a pre-response retryable. (Reaches classifyError only if
  // it ever surfaces as a bare error; the point is the pre-response token must
  // not match it.)
  test("does NOT reclassify http2 mid-body 'closed before end' as network_error (stays bad_request)", () => {
    const error = new Error("[http2] upstream stream closed before end (rstCode=8)")
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
  })

  // The mid-stream buffered-retry truncation is a different string/path — the
  // pre-response token must not swallow it.
  test("does NOT reclassify 'closed without message_stop' truncation as pre-response network_error", () => {
    const error = new Error("upstream stream truncated: closed without message_stop")
    const result = classifyError(error)
    expect(result.type).toBe("bad_request")
  })

  // Structured transport-reason TAG (authoritative + exhaustive over substring).
  // The tag path is proven by tagging errors whose MESSAGE matches a CONFLICTING
  // fallback token — classification must come from the tag, never the substring.
  test("classifies a TAGGED pre-response-close as network_error regardless of message", () => {
    const error = tagTransportError(new Error("opaque transport failure"), "pre-response-close")
    expect(classifyError(error).type).toBe("network_error")
  })

  test("classifies a TAGGED refused-stream as network_error regardless of message", () => {
    const error = tagTransportError(new Error("opaque transport failure"), "refused-stream")
    expect(classifyError(error).type).toBe("network_error")
  })

  test("a TAGGED mid-body-close stays bad_request EVEN when the message matches a retryable substring", () => {
    // Conflicting messages: without the exhaustive tag branch these would fall
    // through to the substring fallback and be mis-classified network_error.
    for (const msg of [
      "Stream closed with error code NGHTTP2_REFUSED_STREAM",
      "[http2] upstream stream closed before any response (rstCode=0)",
      "read ECONNRESET",
    ]) {
      const error = tagTransportError(new Error(msg), "mid-body-close")
      expect(classifyError(error).type, msg).toBe("bad_request")
    }
  })

  test("a TAGGED pre-response-close wins over a conflicting mid-body substring in the message", () => {
    const error = tagTransportError(new Error("[http2] upstream stream closed before end (rstCode=8)"), "pre-response-close")
    expect(classifyError(error).type).toBe("network_error")
  })

  test("the transport tag survives cause-chaining", () => {
    const cause = tagTransportError(new Error("opaque"), "pre-response-close")
    const wrapped = new Error("upstream request failed", { cause })
    expect(classifyError(wrapped).type).toBe("network_error")
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
    const error = new Error("The socket connection was closed unexpectedly. " + "For more information, pass `verbose: true` in the second argument to fetch()")
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

  // ─── aborts must NOT be classified as network_error ─────────────────────
  // Previously `NETWORK_ERROR_PATTERNS` included "abort", which made any
  // AbortSignal-triggered error (client cancel, shutdown, fetch timeout,
  // internal watchdogs) trigger a network-retry. Aborts have opposite retry
  // semantics — the caller no longer wants the result.

  test("classifies AbortError (DOMException-shaped Error) as aborted", () => {
    const error = new Error("The operation was aborted")
    error.name = "AbortError"
    expect(classifyError(error).type).toBe("aborted")
  })

  test("classifies AbortSignal.timeout TimeoutError as aborted", () => {
    const error = new Error("The operation was aborted due to timeout")
    error.name = "TimeoutError"
    expect(classifyError(error).type).toBe("aborted")
  })

  test("classifies project-internal abort messages as aborted (not network_error)", () => {
    expect(classifyError(new Error("Upstream WebSocket request aborted")).type).toBe("aborted")
    expect(classifyError(new Error("Request aborted by client")).type).toBe("aborted")
  })

  test("aborted classification walks cause chain", () => {
    const cause = new Error("operation aborted")
    cause.name = "AbortError"
    const wrapped = new Error("fetch wrapper", { cause })
    expect(classifyError(wrapped).type).toBe("aborted")
  })
})

// ─── formatErrorWithCause ───

describe("formatErrorWithCause", () => {
  test("returns message as-is for simple error", () => {
    const error = new Error("something broke")
    expect(formatErrorWithCause(error)).toBe("something broke")
  })

  test("strips Bun verbose hint", () => {
    const error = new Error("The socket connection was closed unexpectedly. " + "For more information, pass `verbose: true` in the second argument to fetch()")
    expect(formatErrorWithCause(error)).toBe("The socket connection was closed unexpectedly.")
  })

  test("appends cause message", () => {
    const cause = new Error("ECONNRESET")
    const error = new Error("request failed", { cause })
    expect(formatErrorWithCause(error)).toBe("request failed (cause: ECONNRESET)")
  })

  test("strips Bun verbose hint from cause too", () => {
    const cause = new Error("TLS handshake failed. For more information, pass `verbose: true` in the second argument to fetch()")
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
    // forwardError returns error info for a token-limit 400 (parsed via
    // parseTokenLimitError / the forward error formatter).
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

  // ─── abort classification (① — an abort is NOT an "unexpected non-HTTP error") ───

  /** Mock context whose inbound request signal carries an `aborted` flag (client-disconnect indicator). */
  function createMockContextWithSignal(rawSignalAborted: boolean): {
    ctx: Parameters<typeof forwardError>[0]
    getLastJson: () => { data: unknown; status: number }
  } {
    let lastJson: { data: unknown; status: number } | undefined
    const ctx = {
      json: (data: unknown, status?: number) => {
        lastJson = { data, status: status ?? 200 }
        return new Response(JSON.stringify(data), { status: status ?? 200 })
      },
      req: { method: "POST", path: "/v1/messages", raw: { signal: { aborted: rawSignalAborted } } },
    } as unknown as Parameters<typeof forwardError>[0]
    return {
      ctx,
      getLastJson: () => {
        if (!lastJson) throw new Error("json() was never called")
        return lastJson
      },
    }
  }

  function makeAbortError(): Error {
    const e = new Error("The operation was aborted.")
    e.name = "AbortError"
    return e
  }

  test("client disconnect (raw.signal aborted) → 499, not the 500 catch-all", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(true)
    forwardError(ctx, makeAbortError())
    expect(getLastJson().status).toBe(499)
  })

  test("an untagged abort with an un-aborted client signal → 503 with the REAL message, never a fabricated header timeout", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    forwardError(ctx, makeAbortError())
    const { data, status } = getLastJson()
    expect(status).toBe(503)
    // The regression this locks: it used to answer 504 "Upstream timed out before sending
    // response headers" for ANY such abort — a claim with no evidence behind it (2026-07-28:
    // a 609ms request blamed on a 900s timeout).
    expect(JSON.stringify(data)).not.toContain("timed out before sending response headers")
  })

  test("hard request-deadline cancel → 504 naming the deadline, not the header timeout", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    forwardError(ctx, cancellationAbortError("request-deadline", "request_deadline"))
    const { data, status } = getLastJson()
    expect(status).toBe(504)
    expect(JSON.stringify(data)).toContain("request_deadline")
    expect(JSON.stringify(data)).not.toContain("timed out before sending response headers")
  })

  test("stale-reaper cancel → 504, same category as the deadline, carrying the reaper's own reason", () => {
    // The reaper is `stale_request_max_age` expiring — our clock, i.e. a timeout, the same
    // category the SSE `error.type` tables put it in. It used to land in the 503 catch-all
    // alongside dispatch teardowns, which made ONE cause change category depending on which
    // boundary caught it. The message still names the reaper specifically.
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    forwardError(ctx, cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    const { data, status } = getLastJson()
    expect(status).toBe(504)
    expect(JSON.stringify(data)).toContain("stale-request reaper")
  })

  test("a dispatch teardown stays 503 — only OUR clocks get the timeout category", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    forwardError(ctx, cancellationAbortError("dispatch-cancel", "lost hedge race"))
    expect(getLastJson().status).toBe(503)
  })

  test("TimeoutError-named abort with un-aborted client signal → 504", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    const e = new Error("The operation was aborted due to timeout")
    e.name = "TimeoutError"
    forwardError(ctx, e)
    expect(getLastJson().status).toBe(504)
  })

  test("openai format: client disconnect → 499 with api_error envelope", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(true)
    forwardError(ctx, makeAbortError(), "openai")
    const { data, status } = getLastJson()
    expect(status).toBe(499)
    expect((data as { error: { type: string } }).error.type).toBe("api_error")
  })

  test("gemini format: response-header timeout → 504 with DEADLINE_EXCEEDED", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    const e = new Error("The operation was aborted due to timeout")
    e.name = "TimeoutError"
    forwardError(ctx, e, "gemini")
    const { data, status } = getLastJson()
    expect(status).toBe(504)
    expect((data as { error: { status: string } }).error.status).toBe("DEADLINE_EXCEEDED")
  })

  test("a genuinely unexpected non-abort error still falls through to 500", () => {
    const { ctx, getLastJson } = createMockContextWithSignal(false)
    forwardError(ctx, new Error("genuinely unexpected failure"))
    expect(getLastJson().status).toBe(500)
  })
})

// ─── mapHttpErrorToEnvelope (C3b-pre1 — pure dispatch shared by forwardError + RFC ③ POST-COMMIT) ───

describe("mapHttpErrorToEnvelope", () => {
  test("429 (rate_limited body) → anthropic rate_limit_error envelope, status 429, classified, warn log", () => {
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } })
    const out = mapHttpErrorToEnvelope(new HTTPError("Rate limited", 429, body), "anthropic")
    expect(out.status).toBe(429)
    expect(out.classified).toBe(true)
    expect(out.log.level).toBe("warn")
    expect((out.body as { error: { type: string } }).error.type).toBe("rate_limit_error")
  })

  test("402 with Retry-After → quota envelope carries retry_after; log notes the wait", () => {
    const headers = new Headers({ "retry-after": "42" })
    const out = mapHttpErrorToEnvelope(new HTTPError("Quota", 402, "{}", undefined, headers), "anthropic")
    expect(out.status).toBe(402)
    expect((out.body as { retry_after?: number }).retry_after).toBe(42)
    expect(out.log.message).toContain("42")
  })

  test("503 upstream-rate-limited (message-only, no rate_limited code) → openai rate_limit_exceeded, status 503, classified", () => {
    const body = JSON.stringify({ error: { message: "Rate limit exceeded for upstream provider" } })
    const out = mapHttpErrorToEnvelope(new HTTPError("Unavailable", 503, body), "openai")
    expect(out.status).toBe(503)
    expect(out.classified).toBe(true)
    expect((out.body as { error: { type: string } }).error.type).toBe("rate_limit_exceeded")
  })

  test("opaque 500 → default envelope, status 500, NOT classified (where forwardError attaches diagnostics), error log", () => {
    const out = mapHttpErrorToEnvelope(new HTTPError("Boom", 500, "internal failure"), "anthropic")
    expect(out.status).toBe(500)
    expect(out.classified).toBe(false)
    expect(out.log.level).toBe("error")
  })

  test("body matches what forwardError emits (forwardError now delegates to map) — 413 parity", () => {
    const err = new HTTPError("Too large", 413, "")
    const mapped = mapHttpErrorToEnvelope(err, "anthropic")
    expect(mapped.status).toBe(413)
    expect((mapped.body as { error: { type: string } }).error.type).toBe("invalid_request_error")
  })
})
