/**
 * Contract tests for error response format compliance.
 *
 * Verifies that forwardError produces Anthropic-compatible error responses
 * that downstream clients (Claude Code, etc.) can parse correctly,
 * AND that the correct log messages are emitted for operators.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import {
  //
  HTTPError,
  forwardError,
} from "~/lib/error"

// ─── Mocks ───

/** Mock Hono Context that captures json() calls */
function mockContext(overrides?: { method?: string; path?: string }) {
  let lastJson: { data: unknown; status: number } | null = null
  return {
    c: {
      json: (data: unknown, status?: number) => {
        lastJson = { data, status: status ?? 200 }
        return new Response(JSON.stringify(data), {
          status: status ?? 200,
          headers: { "content-type": "application/json" },
        })
      },
      req: {
        url: "http://localhost/test",
        method: overrides?.method ?? "POST",
        path: overrides?.path ?? "/v1/messages",
      },
    } as any,
    getLastResponse: () => lastJson,
  }
}

// ─── Tests ───

describe("error response format compliance", () => {
  let warnSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Silence consola output — LogFn requires both call signature and .raw property
    const noop = Object.assign((..._: Array<any>) => {}, { raw: (..._: Array<any>) => {} })
    warnSpy = spyOn(consola, "warn").mockImplementation(noop)
    errorSpy = spyOn(consola, "error").mockImplementation(noop)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test("413 returns type:error + error.type:invalid_request_error", () => {
    const { c, getLastResponse } = mockContext()
    const error = new HTTPError("Too large", 413, "")

    forwardError(c, error)

    const resp = getLastResponse()!
    expect(resp.status).toBe(413)
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("invalid_request_error")
    expect((resp.data as any).error.message).toContain("Request body too large")

    // Verify log
    expect(warnSpy).toHaveBeenCalledWith("HTTP 413: Request too large")
  })

  test("token limit returns Anthropic prompt_too_long format with current/limit", () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({
      error: {
        message: "prompt token count of 135355 exceeds the limit of 128000",
        code: "model_max_prompt_tokens_exceeded",
      },
    })
    const error = new HTTPError("Token limit", 400, body)

    forwardError(c, error)

    const resp = getLastResponse()!
    expect(resp.status).toBe(400)
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("invalid_request_error")
    expect((resp.data as any).error.message).toContain("prompt is too long")
    expect((resp.data as any).error.message).toContain("135355")
    expect((resp.data as any).error.message).toContain("128000")

    // Verify log includes token details
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logMessage = warnSpy.mock.calls[0].join(" ")
    expect(logMessage).toContain("Token limit exceeded")
    expect(logMessage).toContain("135,355")
    expect(logMessage).toContain("128,000")
  })

  test("429 returns type:error + error.type:rate_limit_error", () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({ error: { message: "You have exceeded your rate limit" } })
    const error = new HTTPError("Rate limited", 429, body)

    forwardError(c, error)

    const resp = getLastResponse()!
    expect(resp.status).toBe(429)
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("rate_limit_error")

    expect(warnSpy).toHaveBeenCalledWith("HTTP 429: Rate limit exceeded")
  })

  test("429 with code:rate_limited in body returns rate_limit_error", () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } })
    const error = new HTTPError("Rate limited", 429, body)

    forwardError(c, error)

    const resp = getLastResponse()!
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("rate_limit_error")
  })

  test("unknown error returns error.type:error with message", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new Error("Something unexpected"))

    const resp = getLastResponse()!
    expect(resp.status).toBe(500)
    expect((resp.data as any).error.type).toBe("error")
    expect((resp.data as any).error.message).toBe("Something unexpected")

    // Verify log includes method, path, and cleaned message
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logArgs = errorSpy.mock.calls[0]
    expect(logArgs[0]).toContain("POST /v1/messages")
    expect(logArgs[1]).toBe("Something unexpected")
  })

  test("socket error strips Bun verbose hint from both response and log", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(
      c,
      new Error("The socket connection was closed unexpectedly. " + "For more information, pass `verbose: true` in the second argument to fetch()"),
    )

    // Response should be cleaned
    const resp = getLastResponse()!
    expect(resp.status).toBe(500)
    expect((resp.data as any).error.message).toBe("The socket connection was closed unexpectedly.")
    expect((resp.data as any).error.message).not.toContain("verbose")

    // Log should also be cleaned
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logMessage = errorSpy.mock.calls[0].join(" ")
    expect(logMessage).toContain("The socket connection was closed unexpectedly.")
    expect(logMessage).not.toContain("verbose")
  })

  test("socket error with cause includes cause in both response and log", () => {
    const { c, getLastResponse } = mockContext()
    const cause = new Error("connection reset by remote host")
    forwardError(c, new Error("The socket connection was closed unexpectedly", { cause }))

    // Response should include cause
    const resp = getLastResponse()!
    expect(resp.status).toBe(500)
    expect((resp.data as any).error.message).toContain("The socket connection was closed unexpectedly")
    expect((resp.data as any).error.message).toContain("cause: connection reset by remote host")

    // Log should include cause
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logMessage = errorSpy.mock.calls[0].join(" ")
    expect(logMessage).toContain("cause: connection reset by remote host")
  })

  // ────────────────────────────────────────────────────────────────────
  // OpenAI wire-format (format="openai")
  //
  // OpenAI SDKs (openai-python, openai-node, LangChain, LiteLLM) parse
  // `error.type` and `error.code` to drive retry/fallback decisions.
  // The proxy must emit OpenAI's canonical literals
  // (rate_limit_exceeded, insufficient_quota, context_length_exceeded, etc.)
  // when serving OpenAI-compatible endpoints.
  // ────────────────────────────────────────────────────────────────────

  test("OpenAI 413 returns request_too_large code (no top-level type:error envelope)", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Too large", 413, ""), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(413)
    expect((resp.data as any).type).toBeUndefined()
    expect((resp.data as any).error.type).toBe("invalid_request_error")
    expect((resp.data as any).error.code).toBe("request_too_large")
  })

  test("OpenAI token-limit returns context_length_exceeded code", () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({
      error: { message: "prompt token count of 150000 exceeds the limit of 128000" },
    })
    forwardError(c, new HTTPError("Token limit", 400, body), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(400)
    expect((resp.data as any).error.code).toBe("context_length_exceeded")
    expect((resp.data as any).error.type).toBe("invalid_request_error")
    expect((resp.data as any).error.param).toBe("messages")
    expect((resp.data as any).error.message).toContain("128000")
  })

  test("OpenAI 429 returns rate_limit_exceeded type and code", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Rate limited", 429, ""), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(429)
    expect((resp.data as any).error.type).toBe("rate_limit_exceeded")
    expect((resp.data as any).error.code).toBe("rate_limit_exceeded")
  })

  test("OpenAI 402 returns insufficient_quota type and code", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Quota", 402, ""), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(402)
    expect((resp.data as any).error.type).toBe("insufficient_quota")
    expect((resp.data as any).error.code).toBe("insufficient_quota")
  })

  test("OpenAI 422 returns content_filter code", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Filtered", 422, ""), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(422)
    expect((resp.data as any).error.code).toBe("content_filter")
  })

  test("OpenAI default 5xx returns server_error type", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, "upstream blew up"), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    expect((resp.data as any).error.type).toBe("server_error")
    expect((resp.data as any).error.message).toContain("upstream blew up")
    expect((resp.data as any).type).toBeUndefined()
  })

  test("OpenAI default 4xx returns api_error type", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad", 400, "malformed payload"), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(400)
    expect((resp.data as any).error.type).toBe("api_error")
    expect((resp.data as any).error.message).toContain("malformed payload")
  })

  test("OpenAI 401 includes invalid_api_key code", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Unauthorized", 401, "bad token"), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(401)
    expect((resp.data as any).error.code).toBe("invalid_api_key")
  })

  test("OpenAI non-HTTP error returns server_error envelope", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new Error("Boom"), "openai")
    const resp = getLastResponse()!
    expect(resp.status).toBe(500)
    expect((resp.data as any).error.type).toBe("server_error")
    expect((resp.data as any).error.message).toContain("Boom")
    expect((resp.data as any).type).toBeUndefined()
  })

  // ────────────────────────────────────────────────────────────────────
  // HTML error pages (e.g. GitHub's "502 Unicorn!" edge page)
  //
  // Gateways/CDNs return full HTML documents on edge failures. Forwarding
  // that verbatim pollutes the client's `error.message` with kilobytes of
  // markup that no API client can use. The proxy substitutes a concise,
  // operator-actionable message; History still retains the raw upstream body.
  // ────────────────────────────────────────────────────────────────────

  const UNICORN_HTML =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>GitHub.com</title>'
    + "<style>body{background:#f0f0f0}</style></head>\n<body>"
    + "<div>Unicorn! </div><p>You can't perform that action at this time.</p>"
    + '<img src="/images/error/unicorn.png"></body></html>'

  test("Anthropic 502 HTML body is replaced with a concise message (no markup)", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, UNICORN_HTML), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    expect((resp.data as any).error.type).toBe("error")

    const message = (resp.data as any).error.message as string
    // No raw HTML leaks through to the client
    expect(message).not.toContain("<")
    expect(message).not.toContain("Unicorn")
    expect(message).not.toBe(UNICORN_HTML)
    // Operator-actionable: mentions the status and that it was an HTML page
    expect(message).toContain("502")
    expect(message.toLowerCase()).toContain("html")
  })

  test("OpenAI 502 HTML body is replaced with a concise server_error message", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, UNICORN_HTML), "openai")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    expect((resp.data as any).error.type).toBe("server_error")

    const message = (resp.data as any).error.message as string
    expect(message).not.toContain("<")
    expect(message).not.toContain("Unicorn")
    expect(message).toContain("502")
  })

  test("Gemini 502 HTML body is replaced with a concise message", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, UNICORN_HTML), "gemini")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)

    const message = (resp.data as any).error.message as string
    expect(message).not.toContain("<")
    expect(message).not.toContain("Unicorn")
    expect(message).toContain("502")
  })

  test("HTML error body is logged as a byte-count summary, not dumped verbatim", () => {
    const { c } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, UNICORN_HTML), "anthropic")

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logMessage = errorSpy.mock.calls[0].join(" ")
    expect(logMessage).toContain(`[HTML ${UNICORN_HTML.length} bytes]`)
    expect(logMessage).not.toContain("Unicorn")
  })

  test("short non-HTML 5xx body is still forwarded verbatim (regression guard)", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, "upstream blew up"), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    expect((resp.data as any).error.message).toBe("upstream blew up")
  })

  test("HTML detected via content-type header even when body lacks a leading <", () => {
    const { c, getLastResponse } = mockContext()
    // Bare-text HTML fragment that does NOT start with `<` — only the
    // upstream content-type header reveals it as a markup page.
    const body = "Unicorn! You can't perform that action at this time."
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" })
    forwardError(c, new HTTPError("Bad gateway", 502, body, undefined, headers), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    const message = (resp.data as any).error.message as string
    expect(message).not.toContain("Unicorn")
    expect(message).not.toBe(body)
    expect(message).toContain("502")
    expect(message.toLowerCase()).toContain("html")
  })

  test("content-type text/html with a valid JSON body stays on the JSON path (string guard)", () => {
    const { c, getLastResponse } = mockContext()
    // Upstream mislabels a JSON error as text/html — the `typeof === "string"`
    // guard keeps it on the JSON path so a usable detail still reaches the client
    // instead of being swallowed by the HTML placeholder.
    const body = JSON.stringify({ error: { message: "genuine upstream detail" } })
    const headers = new Headers({ "content-type": "text/html" })
    forwardError(c, new HTTPError("Bad gateway", 502, body, undefined, headers), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    const message = (resp.data as any).error.message as string
    expect(message.toLowerCase()).not.toContain("html error page")
    expect(message).toContain("genuine upstream detail")
  })

  // ── Decision matrix: empty body is filled; structured JSON is forwarded verbatim ──

  test("empty 5xx body is filled with a synthetic status message (not an empty error)", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 502, ""), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    const message = (resp.data as any).error.message as string
    expect(message).not.toBe("")
    expect(message).toContain("502")
  })

  test("whitespace-only body is treated as empty and filled", () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new HTTPError("Bad gateway", 503, "   \n\t  "), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(503)
    const message = (resp.data as any).error.message as string
    expect(message.trim()).not.toBe("")
    expect(message).toContain("503")
  })

  test("empty body takes priority over a text/html content-type (not reported as a 0-byte HTML page)", () => {
    const { c, getLastResponse } = mockContext()
    const headers = new Headers({ "content-type": "text/html" })
    forwardError(c, new HTTPError("Bad gateway", 502, "", undefined, headers), "anthropic")

    const resp = getLastResponse()!
    const message = (resp.data as any).error.message as string
    expect(message).toContain("empty")
    expect(message).not.toContain("0 bytes")
  })

  test("structured JSON error body is forwarded VERBATIM — proxy does NOT extract .error.message (intentional)", () => {
    const { c, getLastResponse } = mockContext()
    // Decision (DESIGN.md error/): when upstream returns a JSON error body it deliberately
    // chose to expose structured content downstream, so the proxy passes the raw JSON
    // through untouched rather than extracting `.error.message`. This test pins that
    // contract so a future "helpful" extraction can't silently regress it.
    const body = JSON.stringify({ error: { message: "real detail", code: "upstream_boom" } })
    forwardError(c, new HTTPError("Bad gateway", 502, body), "anthropic")

    const resp = getLastResponse()!
    expect(resp.status).toBe(502)
    expect((resp.data as any).error.message).toBe(body)
  })
})
