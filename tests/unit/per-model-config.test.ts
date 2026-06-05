import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  collectAllMatching,
  findMostSpecific,
} from "~/lib/anthropic/per-model-config"

describe("findMostSpecific", () => {
  test("returns undefined when no key matches and no wildcard", () => {
    const patterns = { "claude-opus-4.7": ["medium"] }
    expect(findMostSpecific("gpt-5", patterns)).toBeUndefined()
  })

  test("returns wildcard value when no specific key matches", () => {
    const patterns = { "claude-opus-4.7": ["medium"], "*": ["high"] }
    expect(findMostSpecific("gpt-5", patterns)).toEqual(["high"])
  })

  test("longest matching key wins over shorter overlapping key", () => {
    // Regression: under loose-includes matching, "claude-opus-4.7" leaks into
    // "claude-opus-4.7-high" and forces a wrong [medium] whitelist.
    const patterns = {
      "claude-opus-4.7": ["medium"],
      "claude-opus-4.7-high": ["high"],
    }
    expect(findMostSpecific("claude-opus-4.7-high", patterns)).toEqual(["high"])
    expect(findMostSpecific("claude-opus-4.7-xhigh", patterns)).toEqual(["medium"])
    expect(findMostSpecific("claude-opus-4.7", patterns)).toEqual(["medium"])
  })

  test("specific key wins over wildcard fallback", () => {
    const patterns = { "claude-opus-4.7": ["medium"], "*": ["low", "medium", "high"] }
    expect(findMostSpecific("claude-opus-4.7", patterns)).toEqual(["medium"])
  })

  test("ignores '*' when scoring specificity", () => {
    // A 7-char key like "opus-47" should not be beaten by the wildcard "*"
    // simply because "*" sorts longer in some sense — "*" is always tiebreaker.
    const patterns = { "opus-47": ["medium"], "*": ["low"] }
    expect(findMostSpecific("opus-47", patterns)).toEqual(["medium"])
  })
})

describe("collectAllMatching", () => {
  test("returns empty array when nothing matches", () => {
    expect(collectAllMatching("gpt-5", { "claude-opus-4.7": ["a"] })).toEqual([])
  })

  test("union includes wildcard and specific matches together", () => {
    const patterns = {
      "*": ["global-a"],
      "claude-opus-4.7": ["specific-b"],
    }
    expect(collectAllMatching("claude-opus-4.7", patterns).flat().sort()).toEqual(["global-a", "specific-b"])
  })

  test("collects from every matching key including cascading substrings", () => {
    // Strip semantics: both keys legitimately apply to a 4.7-high model.
    const patterns = {
      "claude-opus-4.7": ["family-strip"],
      "claude-opus-4.7-high": ["variant-strip"],
    }
    expect(collectAllMatching("claude-opus-4.7-high", patterns).flat().sort()).toEqual([
      "family-strip",
      "variant-strip",
    ])
  })
})
