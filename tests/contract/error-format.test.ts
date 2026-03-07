/**
 * Contract tests for error response format compliance.
 *
 * Verifies that forwardError produces Anthropic-compatible error responses
 * that downstream clients (Claude Code, etc.) can parse correctly,
 * AND that the correct log messages are emitted for operators.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import consola from "consola"

import { HTTPError, forwardError } from "~/lib/error"

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
      new Error(
        "The socket connection was closed unexpectedly. "
          + "For more information, pass `verbose: true` in the second argument to fetch()",
      ),
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
})
