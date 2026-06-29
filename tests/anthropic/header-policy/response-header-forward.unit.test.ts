/**
 * Unit tests for the Anthropic upstream-response-header forwarding selector.
 *
 * `selectForwardableResponseHeaders` decides which upstream (GHC) response headers
 * the proxy forwards to the client, gated by a MODE switch + operator glob lists
 * (the client-side mirror of the request-side `strict_request_headers` triple):
 *   - strict=false → BLACKLIST mode: everything EXCEPT the `blacklist` globs.
 *   - strict=true  → WHITELIST mode: ONLY headers matching the `whitelist` globs.
 * Both modes ALWAYS first drop the proxy-controlled set (content framing + hop-by-hop +
 * proxy-decided), so a forwarded header can never corrupt the proxy's own framing.
 *
 * The default lists (`DEFAULT_*`) reproduce the OLD boolean semantics byte-for-byte:
 * strict=true + DEFAULT_WHITELIST == the old hardcoded allowlist; strict=false +
 * empty blacklist == the old permissive "everything except the floor".
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
} from "~/lib/anthropic/header-policy/response-header-forward"

/** Default whitelist (mirrors CONFIG_MANAGED_DEFAULTS.responseHeaderWhitelist) = old strict allowlist. */
const DEFAULT_WHITELIST = ["request-id", "x-request-id", "anthropic-ratelimit-*", "anthropic-organization-id", "retry-after"]

/** Old strict=true behavior: WHITELIST mode with the default allowlist. */
const strictDefault = { strict: true, blacklist: [], whitelist: DEFAULT_WHITELIST }
/** Old strict=false behavior: BLACKLIST mode with an empty blacklist (floor only). */
const permissiveDefault = { strict: false, blacklist: [], whitelist: [] }

describe("selectForwardableResponseHeaders", () => {
  describe("whitelist mode (strict, default allowlist == old strict=true)", () => {
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
        strictDefault,
      )
      expect(result).toEqual({
        "request-id": "req_abc",
        "x-request-id": "xreq_abc",
        "anthropic-organization-id": "org_123",
        "retry-after": "30",
      })
    })

    test("keeps any anthropic-ratelimit-* via glob (mirrors the old prefix match)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["anthropic-ratelimit-requests-remaining", "100"],
          ["anthropic-ratelimit-tokens-reset", "2026-06-29T00:00:00Z"],
          ["anthropic-unrelated", "should-drop"],
        ],
        strictDefault,
      )
      expect(result).toEqual({
        "anthropic-ratelimit-requests-remaining": "100",
        "anthropic-ratelimit-tokens-reset": "2026-06-29T00:00:00Z",
      })
    })
  })

  describe("blacklist mode (permissive, empty blacklist == old strict=false)", () => {
    test("keeps arbitrary upstream fields", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["request-id", "req_abc"],
          ["anthropic-ratelimit-requests-remaining", "100"],
          ["x-internal-foo", "keep-me"],
          ["x-served-by", "keep-me-too"],
          ["etag", 'W/"abc"'],
        ],
        permissiveDefault,
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

  describe("operator-customizable glob lists (the new capability)", () => {
    test("blacklist mode: a glob strips matching upstream headers, keeps the rest", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["x-internal-foo", "drop"],
          ["x-internal-bar", "drop"],
          ["request-id", "keep"],
          ["x-served-by", "keep"],
        ],
        { strict: false, blacklist: ["x-internal-*"], whitelist: [] },
      )
      expect(result).toEqual({ "request-id": "keep", "x-served-by": "keep" })
    })

    test("blacklist mode: ['*'] empties the floored set", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["request-id", "drop"],
          ["x-served-by", "drop"],
        ],
        { strict: false, blacklist: ["*"], whitelist: [] },
      )
      expect(result).toEqual({})
    })

    test("whitelist mode: a custom whitelist keeps only its matches", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["x-served-by", "keep"],
          ["request-id", "drop-now"],
          ["x-internal-foo", "drop"],
        ],
        { strict: true, blacklist: [], whitelist: ["x-served-by"] },
      )
      expect(result).toEqual({ "x-served-by": "keep" })
    })

    test("whitelist mode: an empty whitelist forwards nothing (full isolation)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["request-id", "drop"],
          ["anthropic-ratelimit-x", "drop"],
        ],
        { strict: true, blacklist: [], whitelist: [] },
      )
      expect(result).toEqual({})
    })
  })

  describe("proxy-controlled floor (both modes)", () => {
    // The content-framing four are load-bearing: forwarding upstream content-length
    // after the proxy re-serializes (esp. runResponseWhole body rewrite) makes the
    // client parse the wrong number of bytes.
    test.each(["content-length", "content-encoding", "content-type", "transfer-encoding", "connection", "set-cookie", "cache-control", "date", "keep-alive"])(
      "drops %s in blacklist mode",
      (header) => {
        const result = selectForwardableResponseHeaders(
          [
            [header, "x"],
            ["request-id", "keep"],
          ],
          permissiveDefault,
        )
        expect(result).not.toHaveProperty(header)
        expect(result).toHaveProperty("request-id", "keep")
      },
    )

    test("floor drops content-length even in whitelist mode (whitelist cannot re-admit it)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["content-length", "1234"],
          ["request-id", "keep"],
        ],
        // even a whitelist that names content-length cannot re-admit it — the floor runs first.
        { strict: true, blacklist: [], whitelist: ["content-length", "request-id"] },
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
    test("lowercases header names before matching (whitelist mode)", () => {
      const result = selectForwardableResponseHeaders(
        [
          ["Request-Id", "req_abc"],
          ["ANTHROPIC-RATELIMIT-REQUESTS-REMAINING", "100"],
          ["Content-Length", "1234"],
        ],
        strictDefault,
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
      const result = selectForwardableResponseHeaders(headers, permissiveDefault)
      expect(result).toEqual({ "request-id": "req_abc", "x-internal-foo": "keep" })
    })
  })
})
