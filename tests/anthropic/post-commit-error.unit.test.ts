/**
 * Unit tests for the POST-COMMIT error-frame helpers (③ pre-response-grace, RFC §4.2.5).
 * Pure functions — no runtime. Lock the canonical-literal preservation (the Q2 make-or-break:
 * the `error.type` literal is what the client SDK branches on) + the signal-state discriminator.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { HTTPError } from "~/lib/error"

import {
  //
  anthropicErrorFrame,
  anthropicHttpErrorFrame,
  anthropicRejectErrorFrame,
  classifyPostCommitAbort,
  toAnthropicSseErrorData,
} from "../../src/routes/messages/post-commit-error"

function parse(frame: { event?: string; data?: string }): { type?: string; error?: { type?: string; message?: string; retry_after?: number } } {
  expect(frame.event).toBe("error")
  return JSON.parse(frame.data ?? "{}") as { type?: string; error?: { type?: string; message?: string; retry_after?: number } }
}

describe("toAnthropicSseErrorData", () => {
  test("classified body passes through verbatim (preserves error.type + retry_after)", () => {
    const body = { type: "error", error: { type: "rate_limit_error", message: "slow down", retry_after: 30 } }
    expect(toAnthropicSseErrorData(body, 429, true)).toEqual(body)
  })

  test("default mis-shaped body (4xx) is reshaped to canonical invalid_request_error", () => {
    const body = { error: { message: "bad input", type: "error" } }
    expect(toAnthropicSseErrorData(body, 400, false)).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad input" } })
  })

  test("default mis-shaped body (5xx) is reshaped to canonical api_error", () => {
    const body = { error: { message: "boom", type: "error" } }
    expect(toAnthropicSseErrorData(body, 503, false)).toEqual({ type: "error", error: { type: "api_error", message: "boom" } })
  })

  test("default body without a usable message falls back to a stable string", () => {
    const out = toAnthropicSseErrorData({ error: {} }, 400, false) as { error: { message: string } }
    expect(out.error.message).toBe("upstream error")
  })
})

describe("anthropicHttpErrorFrame", () => {
  test("429 → rate_limit_error + retry_after preserved (Q2 make-or-break)", () => {
    // A 429 HTTPError with a Retry-After surfaces the canonical literal + retry_after via mapHttpErrorToEnvelope.
    const err = new HTTPError("rate limited", 429, JSON.stringify({ error: { type: "rate_limit_error", message: "rate limited" } }))
    ;(err as unknown as { retryAfterSeconds?: number }).retryAfterSeconds = 30
    const data = parse(anthropicHttpErrorFrame(err))
    expect(data.type).toBe("error")
    expect(data.error?.type).toBe("rate_limit_error")
  })

  test("frame shape is a valid Anthropic SSE error event (top-level type:error)", () => {
    const err = new HTTPError("nope", 400, JSON.stringify({ error: { message: "nope" } }))
    const data = parse(anthropicHttpErrorFrame(err))
    expect(data.type).toBe("error")
    expect(data.error?.type).toBeDefined()
  })
})

describe("anthropicRejectErrorFrame", () => {
  test("decideRoute reject (no HTTPError) → canonical 400 invalid_request_error frame", () => {
    const data = parse(anthropicRejectErrorFrame(400, "model not supported"))
    expect(data.type).toBe("error")
    expect(data.error?.type).toBe("invalid_request_error")
    expect(data.error?.message).toContain("model not supported")
  })
})

describe("anthropicErrorFrame", () => {
  test("explicit type+message → canonical envelope", () => {
    const data = parse(anthropicErrorFrame("api_error", "Upstream timed out before sending response headers"))
    expect(data).toEqual({ type: "error", error: { type: "api_error", message: "Upstream timed out before sending response headers" } })
  })
})

describe("classifyPostCommitAbort — signal-state precedence (client > reaper > timeout)", () => {
  test("client-abort wins even if reaper also fired", () => {
    expect(classifyPostCommitAbort(true, true)).toBe("client-abort")
    expect(classifyPostCommitAbort(true, false)).toBe("client-abort")
  })

  test("reaper-cancel when only the lifecycle (reaper) signal flipped", () => {
    expect(classifyPostCommitAbort(false, true)).toBe("reaper-cancel")
  })

  test("timeout when neither signal flipped (header-wait elapsed)", () => {
    expect(classifyPostCommitAbort(false, false)).toBe("timeout")
  })
})
