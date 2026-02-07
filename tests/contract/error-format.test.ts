/**
 * Contract tests for error response format compliance.
 *
 * Verifies that forwardError produces Anthropic-compatible error responses
 * that downstream clients (Claude Code, etc.) can parse correctly.
 */

import { describe, expect, test } from "bun:test"

import { HTTPError, forwardError } from "~/lib/error"

// Create a minimal Hono Context mock that captures json() calls
function mockContext() {
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
      req: { url: "http://localhost/test" },
    } as any,
    getLastResponse: () => lastJson,
  }
}

describe("error response format compliance", () => {
  test("413 returns type:error + error.type:invalid_request_error", async () => {
    const { c, getLastResponse } = mockContext()
    const error = new HTTPError("Too large", 413, "")

    forwardError(c, error)

    const resp = getLastResponse()!
    expect(resp.status).toBe(413)
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("invalid_request_error")
    expect((resp.data as any).error.message).toContain("Request body too large")
  })

  test("token limit returns Anthropic prompt_too_long format with current/limit", async () => {
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
  })

  test("429 returns type:error + error.type:rate_limit_error", async () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({ error: { message: "You have exceeded your rate limit" } })
    const error = new HTTPError("Rate limited", 429, body)

    forwardError(c, error)

    const resp = getLastResponse()!
    expect(resp.status).toBe(429)
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("rate_limit_error")
  })

  test("429 with code:rate_limited in body returns rate_limit_error", async () => {
    const { c, getLastResponse } = mockContext()
    const body = JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } })
    const error = new HTTPError("Rate limited", 429, body)

    forwardError(c, error)

    const resp = getLastResponse()!
    expect((resp.data as any).type).toBe("error")
    expect((resp.data as any).error.type).toBe("rate_limit_error")
  })

  test("unknown error returns error.type:error with message", async () => {
    const { c, getLastResponse } = mockContext()
    forwardError(c, new Error("Something unexpected"))

    const resp = getLastResponse()!
    expect(resp.status).toBe(500)
    expect((resp.data as any).error.type).toBe("error")
    expect((resp.data as any).error.message).toBe("Something unexpected")
  })
})
