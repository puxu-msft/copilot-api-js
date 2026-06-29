import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  keepHeaders,
  pruneHeaders,
} from "~/lib/anthropic/header-policy/header-glob-strip"

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

describe("keepHeaders (glob allow — pruneHeaders' retain-only dual)", () => {
  test("keeps only glob-matched names, drops the rest", () => {
    expect(keepHeaders({ "x-stainless-os": "linux", "x-custom": "v", accept: "application/json" }, ["x-stainless-*", "accept"])).toEqual({
      "x-stainless-os": "linux",
      accept: "application/json",
    })
  })

  test("SEMANTIC INVERSION: empty allow-list keeps NOTHING (returns {})", () => {
    // Mirror-opposite of pruneHeaders([]) which keeps everything.
    expect(keepHeaders({ "x-a": "1", "x-b": "2" }, [])).toEqual({})
  })

  test("case-insensitive glob match", () => {
    expect(keepHeaders({ "X-Claude-Code-Agent-Id": "sub", "x-custom": "v" }, ["x-claude-code-*"])).toEqual({ "X-Claude-Code-Agent-Id": "sub" })
  })

  test("no match keeps nothing", () => {
    expect(keepHeaders({ "x-custom": "v" }, ["x-stainless-*"])).toEqual({})
  })

  test("never mutates input", () => {
    const input = { "x-stainless-os": "linux", "x-custom": "v" }
    keepHeaders(input, ["x-stainless-*"])
    expect(input).toEqual({ "x-stainless-os": "linux", "x-custom": "v" })
  })
})
