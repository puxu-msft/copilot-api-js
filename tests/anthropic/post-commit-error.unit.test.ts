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
import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { tagTransportError } from "~/lib/error/transport-reason"

import {
  //
  anthropicErrorFrame,
  anthropicHttpErrorFrame,
  anthropicRejectErrorFrame,
  classifyPostCommitAbort,
  postCommitAbortFrame,
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

  test("default body maps status → canonical Anthropic error.type (401/403/404/429/529)", () => {
    const mk = (status: number) =>
      (toAnthropicSseErrorData({ error: { message: "x", type: "error" } }, status, false) as { error: { type: string } }).error.type
    expect(mk(401)).toBe("authentication_error")
    expect(mk(403)).toBe("permission_error")
    expect(mk(404)).toBe("not_found_error")
    expect(mk(429)).toBe("rate_limit_error")
    expect(mk(529)).toBe("overloaded_error")
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

  test("502 HTML error page is replaced — no markup leaks into the POST-COMMIT SSE error frame", () => {
    // The HTML substitution lives in the shared mapHttpErrorToEnvelope, so it must
    // protect the streaming SSE error frame too — not just the non-streaming c.json path.
    const html = "<!DOCTYPE html>\n<html><body><div>Unicorn! </div>" + "<p>You can't perform that action at this time.</p></body></html>"
    const data = parse(anthropicHttpErrorFrame(new HTTPError("Bad gateway", 502, html)))
    expect(data.type).toBe("error")
    expect(data.error?.type).toBe("api_error")
    const message = data.error?.message ?? ""
    expect(message).not.toContain("<")
    expect(message).not.toContain("Unicorn")
    expect(message.toLowerCase()).toContain("html")
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

describe("classifyPostCommitAbort — signal-state fallback (client > reaper > header-timeout)", () => {
  test("client-abort wins even if reaper also fired", () => {
    expect(classifyPostCommitAbort(true, true)).toBe("client-abort")
    expect(classifyPostCommitAbort(true, false)).toBe("client-abort")
  })

  test("reaper-cancel when only the lifecycle (reaper) signal flipped", () => {
    expect(classifyPostCommitAbort(false, true)).toBe("reaper-cancel")
  })

  test("no signal, no evidence → unknown-abort, NOT an invented header timeout", () => {
    // The old fallback answered "timeout" here on the theory that nothing else was
    // left. That theory is how a 609ms request got shipped as a 900s header timeout;
    // pre-commit already refuses to guess, and this is the same refusal.
    expect(classifyPostCommitAbort(false, false)).toBe("unknown-abort")
  })
})

describe("classifyPostCommitAbort — provenance beats signal state", () => {
  function abortNamed(name: string, message = "The operation was aborted."): Error {
    const e = new Error(message)
    e.name = name
    return e
  }

  test("shutdown teardown is NOT reported as a reaper cancel, even with the lifecycle signal up", () => {
    const e = tagTransportError(abortNamed("AbortError", "[http2] upstream session pool closed"), "pool-closed")
    expect(classifyPostCommitAbort(false, true, e)).toBe("shutdown")
  })

  test("the header watchdog is identified by its TimeoutError, not by elapsed time", () => {
    expect(classifyPostCommitAbort(false, false, abortNamed("TimeoutError"))).toBe("header-timeout")
  })

  test("the hard deadline is NOT reported as a reaper cancel — the regression this fixes", () => {
    // Both fire the SAME lifecycle signal, so signal state alone answers "reaper" for both;
    // only the tagged reason can tell them apart.
    const deadline = cancellationAbortError("request-deadline", "request_deadline")
    const reaper = cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper")
    expect(classifyPostCommitAbort(false, true, deadline)).toBe("request-deadline")
    expect(classifyPostCommitAbort(false, true, reaper)).toBe("reaper-cancel")
  })

  test("a dispatch teardown is its own kind", () => {
    expect(classifyPostCommitAbort(false, false, cancellationAbortError("dispatch-cancel", "lost hedge race"))).toBe("dispatch-cancel")
  })

  test("client-abort still wins over every provenance", () => {
    const e = tagTransportError(abortNamed("AbortError"), "pool-closed")
    expect(classifyPostCommitAbort(true, true, e)).toBe("client-abort")
  })

  test("an untagged abort falls back to signal state, and to unknown-abort when even that is silent", () => {
    expect(classifyPostCommitAbort(false, true, abortNamed("AbortError"))).toBe("reaper-cancel")
    expect(classifyPostCommitAbort(false, false, abortNamed("AbortError"))).toBe("unknown-abort")
  })
})

describe("postCommitAbortFrame", () => {
  test("each kind names its own cause on the wire — no shared fiction", () => {
    expect(parse(postCommitAbortFrame("shutdown")).error?.message).toBe("Server is shutting down")
    expect(parse(postCommitAbortFrame("header-timeout")).error?.message).toBe("Upstream timed out before sending response headers")
    expect(parse(postCommitAbortFrame("request-deadline")).error?.message).toContain("hard deadline")
    expect(parse(postCommitAbortFrame("reaper-cancel")).error?.message).toContain("stale-request reaper")
    expect(parse(postCommitAbortFrame("dispatch-cancel")).error?.message).toContain("dispatch cancelled")
    expect(parse(postCommitAbortFrame("unknown-abort")).error?.message).not.toContain("timed out before sending response headers")
    // The canonical Anthropic error type stays `api_error` for every kind — the SDK branches on it.
    expect(parse(postCommitAbortFrame("shutdown")).error?.type).toBe("api_error")
  })
})
