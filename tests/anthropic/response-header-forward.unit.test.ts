/**
 * Unit tests for the Anthropic upstream-response-header forwarding selector.
 *
 * `selectForwardableResponseHeaders` decides which upstream (GHC) response headers
 * the proxy forwards to the client, gated by `strict`:
 *   - strict=true  → only an allowlist (request-id / x-request-id / anthropic-ratelimit-* /
 *     anthropic-organization-id / retry-after)
 *   - strict=false → everything EXCEPT the proxy-controlled blacklist
 * Both modes ALWAYS drop the proxy-controlled set (content framing + hop-by-hop +
 * proxy-decided), so a forwarded header can never corrupt the proxy's own framing.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  PROXY_CONTROLLED_RESPONSE_HEADERS,
  selectForwardableResponseHeaders,
} from "~/lib/anthropic/response-header-forward"

describe("selectForwardableResponseHeaders", () => {
  describe("strict mode (allowlist only)", () => {
    test("keeps the known allowlist fields, drops arbitrary upstream fields", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["request-id", "req_abc"],
          ["x-request-id", "xreq_abc"],
          ["anthropic-organization-id", "org_123"],
          ["retry-after", "30"],
          ["x-internal-foo", "should-drop"],
          ["x-served-by", "should-drop"],
        ],
        true,
      )
      expect(result).toEqual({
        "request-id": "req_abc",
        "x-request-id": "xreq_abc",
        "anthropic-organization-id": "org_123",
        "retry-after": "30",
      })
    })

    test("keeps any anthropic-ratelimit-* via prefix match", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["anthropic-ratelimit-requests-remaining", "100"],
          ["anthropic-ratelimit-tokens-reset", "2026-06-29T00:00:00Z"],
          ["anthropic-unrelated", "should-drop"],
        ],
        true,
      )
      expect(result).toEqual({
        "anthropic-ratelimit-requests-remaining": "100",
        "anthropic-ratelimit-tokens-reset": "2026-06-29T00:00:00Z",
      })
    })
  })

  describe("permissive mode (everything except blacklist)", () => {
    test("keeps arbitrary upstream fields", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["request-id", "req_abc"],
          ["anthropic-ratelimit-requests-remaining", "100"],
          ["x-internal-foo", "keep-me"],
          ["x-served-by", "keep-me-too"],
          ["etag", 'W/"abc"'],
        ],
        false,
      )
      expect(result).toEqual({
        "request-id": "req_abc",
        "anthropic-ratelimit-requests-remaining": "100",
        "x-internal-foo": "keep-me",
        "x-served-by": "keep-me-too",
        etag: 'W/"abc"',
      })
    })
  })

  describe("proxy-controlled blacklist (both modes)", () => {
    // The content-framing four are load-bearing: forwarding upstream content-length
    // after the proxy re-serializes (esp. runResponseWhole body rewrite) makes the
    // client parse the wrong number of bytes.
    test.each(["content-length", "content-encoding", "content-type", "transfer-encoding", "connection", "set-cookie", "cache-control", "date", "keep-alive"])(
      "drops %s in permissive mode",
      (header) => {
        const result = selectForwardableResponseHeaders(
          [
            [header, "x"],
            ["request-id", "keep"],
          ],
          false,
        )
        expect(result).not.toHaveProperty(header)
        expect(result).toHaveProperty("request-id", "keep")
      },
    )

    test("drops content-length even when it would otherwise be allowlisted-adjacent (strict)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["content-length", "1234"],
          ["request-id", "keep"],
        ],
        true,
      )
      expect(result).toEqual({ "request-id": "keep" })
    })

    test("PROXY_CONTROLLED set is non-empty and covers the framing four", () => {
      for (const h of ["content-length", "content-encoding", "content-type", "transfer-encoding"]) {
        expect(PROXY_CONTROLLED_RESPONSE_HEADERS.has(h)).toBe(true)
      }
    })
  })

  describe("name normalization", () => {
    // Real callers pass a `Headers` (already lowercased), but the selector must
    // normalize defensively so a raw mixed-case iterable is handled identically.
    test("lowercases header names before matching (strict allowlist)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["Request-Id", "req_abc"],
          ["ANTHROPIC-RATELIMIT-REQUESTS-REMAINING", "100"],
          ["Content-Length", "1234"],
        ],
        true,
      )
      expect(result).toEqual({
        "request-id": "req_abc",
        "anthropic-ratelimit-requests-remaining": "100",
      })
    })

    test("accepts a Headers object (the real call shape)", () => {
      const headers = new Headers()
      headers.set("request-id", "req_abc")
      headers.set("content-type", "application/json")
      headers.set("x-internal-foo", "keep")
      const result = selectForwardableResponseHeaders(headers, false)
      expect(result).toEqual({ "request-id": "req_abc", "x-internal-foo": "keep" })
    })
  })
})
