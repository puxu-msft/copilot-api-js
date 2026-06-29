import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  pruneHeaders,
  selectPassthroughHeaders,
} from "~/lib/anthropic/strip-headers"

describe("selectPassthroughHeaders", () => {
  const core = new Set(["authorization", "content-type", "x-github-api-version", "openai-intent", "anthropic-version", "anthropic-beta"])

  test("keeps client headers that are neither core nor sensitive", () => {
    const out = selectPassthroughHeaders({ "x-custom": "v", "x-trace-id": "t" }, core)
    expect(out).toEqual({ "x-custom": "v", "x-trace-id": "t" })
  })

  test("drops proxy core keys (case-insensitive)", () => {
    // Client keys arrive lowercased from Headers.entries(); defensively test mixed case too.
    const out = selectPassthroughHeaders({ authorization: "Bearer client", "Content-Type": "x", "x-keep": "1" }, core)
    expect(out).toEqual({ "x-keep": "1" })
  })

  test("drops the sensitive denylist (credentials, body framing, hop-by-hop, forwarded chain)", () => {
    const client = {
      cookie: "a=b",
      "x-api-key": "sk-1",
      "api-key": "sk-2",
      host: "evil.example",
      "content-length": "999",
      "content-encoding": "gzip",
      "accept-encoding": "gzip",
      expect: "100-continue",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      via: "1.1 proxy",
      forwarded: "for=1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-port": "443",
      "cf-connecting-ip": "1.2.3.4",
      "true-client-ip": "1.2.3.4",
      "x-kept": "ok",
    }
    expect(selectPassthroughHeaders(client, core)).toEqual({ "x-kept": "ok" })
  })

  test("drops proxy-owned namespaces by prefix (x-github-*, openai-*)", () => {
    const out = selectPassthroughHeaders({ "x-github-foo": "1", "openai-organization": "2", "x-other": "3" }, core)
    expect(out).toEqual({ "x-other": "3" })
  })

  test("never mutates the input", () => {
    const client = { "x-keep": "1", cookie: "a=b" }
    selectPassthroughHeaders(client, core)
    expect(client).toEqual({ "x-keep": "1", cookie: "a=b" })
  })
})

describe("pruneHeaders (glob strip)", () => {
  test("removes glob-matched names", () => {
    expect(pruneHeaders({ "x-anthropic-billing-header": "v", "x-keep": "1" }, ["x-anthropic-billing-header"])).toEqual({ "x-keep": "1" })
  })

  test("empty pattern list is a no-op (returns input)", () => {
    const input = { "x-a": "1" }
    expect(pruneHeaders(input, [])).toBe(input)
  })

  test("wildcard strips everything except PROTECTED_HEADERS", () => {
    const out = pruneHeaders({ authorization: "a", "content-type": "b", "x-foo": "c", "x-bar": "d" }, ["*"])
    // authorization + content-type are protected; the rest are stripped.
    expect(out).toEqual({ authorization: "a", "content-type": "b" })
  })

  test("case-insensitive glob match", () => {
    expect(pruneHeaders({ "X-Anthropic-Billing-Header": "v", "x-keep": "1" }, ["x-anthropic-*"])).toEqual({ "x-keep": "1" })
  })
})
