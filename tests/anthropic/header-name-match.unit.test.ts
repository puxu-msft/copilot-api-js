import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { matchesHeaderName } from "~/lib/anthropic/header-name-match"

describe("matchesHeaderName", () => {
  const exact = new Set(["cookie", "x-api-key"])
  const prefixes = ["x-github-", "openai-"]

  test("matches an exact (lowercased) name", () => {
    expect(matchesHeaderName("cookie", exact, prefixes)).toBe(true)
    expect(matchesHeaderName("x-api-key", exact, prefixes)).toBe(true)
  })

  test("matches a prefix", () => {
    expect(matchesHeaderName("x-github-foo", exact, prefixes)).toBe(true)
    expect(matchesHeaderName("openai-organization", exact, prefixes)).toBe(true)
  })

  test("does not match unrelated names", () => {
    expect(matchesHeaderName("x-custom", exact, prefixes)).toBe(false)
    expect(matchesHeaderName("authorization", exact, prefixes)).toBe(false)
  })

  test("empty prefix list still matches exact", () => {
    expect(matchesHeaderName("cookie", exact, [])).toBe(true)
    expect(matchesHeaderName("x-github-foo", exact, [])).toBe(false)
  })
})
