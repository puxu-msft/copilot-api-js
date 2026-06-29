import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { selectPassthroughHeaders } from "~/lib/anthropic/header-policy/request-header-forward"

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
