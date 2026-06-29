import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { pruneHeaders } from "~/lib/anthropic/header-policy/header-glob-strip"

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
