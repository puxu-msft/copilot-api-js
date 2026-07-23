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
    expect(collectAllMatching("claude-opus-4.7-high", patterns).flat().sort()).toEqual(["family-strip", "variant-strip"])
  })
})

describe("normalized matching (dot/hyphen/case spelling differences)", () => {
  test("findMostSpecific matches when key and model differ only by dot/hyphen", () => {
    // Request model is the canonical dot form; operator wrote the hyphen form.
    expect(findMostSpecific("claude-opus-4.8", { "claude-opus-4-8": ["high"] })).toEqual(["high"])
    // …and the reverse spelling direction.
    expect(findMostSpecific("claude-opus-4-8", { "claude-opus-4.8": ["high"] })).toEqual(["high"])
  })

  test("findMostSpecific matches case-insensitively", () => {
    expect(findMostSpecific("claude-opus-4.8", { "Claude-Opus-4.8": ["high"] })).toEqual(["high"])
  })

  test("collectAllMatching matches across dot/hyphen spelling", () => {
    const patterns = { "claude-opus-4-8": ["beta-x"], "*": ["base"] }
    expect(collectAllMatching("claude-opus-4.8", patterns).flat().sort()).toEqual(["base", "beta-x"])
  })
})

describe("glob keys + specificity ordering (spec 2026-07-23)", () => {
  test("plain key keeps substring; glob key anchored", () => {
    expect(findMostSpecific("claude-opus-4-7-high", { "claude-opus-4-7": ["a"] })).toEqual(["a"])
    expect(findMostSpecific("claude-opus-4-8", { "claude-*": ["g"] })).toEqual(["g"])
    expect(findMostSpecific("xclaude", { "claude-*": ["g"] })).toBeUndefined() // anchored, not substring
  })

  test("literal key outranks glob key even when glob string is longer", () => {
    // "*claude-opus-4-8" (glob) vs "claude-opus-4-8" (literal): literal must win despite the
    // glob key string being longer.
    const patterns = { "claude-opus-4-8": ["literal"], "*claude-opus-4-8": ["glob"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["literal"])
  })

  test("among glob keys, longest literal length wins", () => {
    const patterns = { "claude-*": ["broad"], "claude-opus-*": ["narrow"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["narrow"])
  })

  test('"*" wildcard stays last-resort under glob keys', () => {
    const patterns = { "claude-*": ["g"], "*": ["fallback"] }
    expect(findMostSpecific("claude-opus-4-8", patterns)).toEqual(["g"])
    expect(findMostSpecific("gpt-4", patterns)).toEqual(["fallback"])
  })

  test("collectAllMatching unions glob + plain keys", () => {
    const patterns = { "claude-*": ["glob"], "claude-opus-4-8": ["exact"], "*": ["base"] }
    expect(collectAllMatching("claude-opus-4-8", patterns).flat().sort()).toEqual(["base", "exact", "glob"])
  })
})
