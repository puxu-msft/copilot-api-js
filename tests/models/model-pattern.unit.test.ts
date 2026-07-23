import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  globToRegExp,
  hasGlobMeta,
  matchesModelKey,
  matchesModelPattern,
  modelMatchesPatternList,
} from "~/lib/models/model-pattern"

// 冻结一份 legacy family-prefix 参考实现作为等价性 oracle。
// 旧 matchModelCapability 是 module-private 且将被替换，不能直接引用——故在此冻结。
function legacyMatch(id: string, prefixes: ReadonlyArray<string>, family?: string): boolean {
  const norm = (s: string) => s.toLowerCase().replaceAll(".", "-")
  const candidates = family ? [norm(id), norm(family)] : [norm(id)]
  return prefixes.some((p) => {
    const np = norm(p)
    return candidates.some((n) => n === np || n.startsWith(`${np}-`))
  })
}

describe("hasGlobMeta", () => {
  test("detects * and ?", () => {
    expect(hasGlobMeta("claude-*")).toBe(true)
    expect(hasGlobMeta("claude-opus-4?")).toBe(true)
    expect(hasGlobMeta("claude-opus-4")).toBe(false)
    expect(hasGlobMeta("!claude-haiku-4-5")).toBe(false)
  })
})

describe("globToRegExp (pure, no normalization)", () => {
  test("* → .*, ? → ., anchored, case-insensitive", () => {
    expect(globToRegExp("claude-*").test("claude-opus")).toBe(true)
    expect(globToRegExp("claude-*").test("xclaude-opus")).toBe(false) // anchored
    expect(globToRegExp("CLAUDE-*").test("claude-opus")).toBe(true) // i flag
    expect(globToRegExp("a?c").test("abc")).toBe(true)
    expect(globToRegExp("a?c").test("ac")).toBe(false)
  })
  test("escapes regex metachars so they are literal", () => {
    // '.' and '+' must NOT act as regex wildcards.
    expect(globToRegExp("a.c").test("axc")).toBe(false)
    expect(globToRegExp("a.c").test("a.c")).toBe(true)
    expect(globToRegExp("a+c").test("aaac")).toBe(false)
  })
  test("escapes the full regex metachar set (table-driven)", () => {
    // Each char must match itself literally, not act as a regex operator.
    for (const ch of ["[", "]", "\\", "^", "$", "|", "(", ")", "{", "}"]) {
      expect(globToRegExp(`a${ch}b`).test(`a${ch}b`)).toBe(true)
      expect(globToRegExp(`a${ch}b`).test("axb")).toBe(false)
    }
  })
  test("does NOT normalize dots to dashes", () => {
    // Pure compiler: header side depends on this staying literal.
    expect(globToRegExp("claude-opus-4.6").test("claude-opus-4-6")).toBe(false)
  })
})

describe("matchesModelPattern (normalizes both sides, then dispatches)", () => {
  test("plain token → family prefix with dash boundary", () => {
    expect(matchesModelPattern("claude-opus-4", "claude-opus-4")).toBe(true)
    expect(matchesModelPattern("claude-opus-4-8", "claude-opus-4")).toBe(true)
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4")).toBe(false) // dash boundary
  })
  test("dot/hyphen spelling normalized on both sides", () => {
    expect(matchesModelPattern("claude-opus-4.6", "claude-opus-4-6")).toBe(true)
  })
  test("glob token → anchored glob after normalization", () => {
    expect(matchesModelPattern("claude-opus-4-8", "claude-opus-4-*")).toBe(true)
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4-*")).toBe(false) // explicit dash in glob
    expect(matchesModelPattern("claude-opus-40", "claude-opus-4*")).toBe(true) // no dash → matches 40
  })
})

describe("modelMatchesPatternList (self-contained, exclusion-always-wins)", () => {
  test("pure positive == legacy family semantics", () => {
    expect(modelMatchesPatternList("claude-sonnet-4-5", ["claude-sonnet-4"])).toBe(true)
    expect(modelMatchesPatternList("claude-sonnet-40", ["claude-sonnet-4"])).toBe(false)
  })
  test("glob positive", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", ["claude-*"])).toBe(true)
  })
  test("negative subtracts, order-independent", () => {
    const list = ["claude-*", "!claude-haiku-*"]
    expect(modelMatchesPatternList("claude-opus-4-8", list)).toBe(true)
    expect(modelMatchesPatternList("claude-haiku-4-5", list)).toBe(false)
    // reversed order — same result
    const rev = ["!claude-haiku-*", "claude-*"]
    expect(modelMatchesPatternList("claude-haiku-4-5", rev)).toBe(false)
  })
  test("only negatives → empty set", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", ["!claude-haiku-*"])).toBe(false)
  })
  test("empty list → false", () => {
    expect(modelMatchesPatternList("claude-opus-4-8", [])).toBe(false)
  })
  test("negative hits via family candidate too (asymmetric id/family)", () => {
    // id positive via glob, family hits a negative → excluded.
    expect(modelMatchesPatternList("vendor-alias", ["*", "!claude-haiku-*"], "claude-haiku-4-5")).toBe(false)
    // reverse: family hits positive, id hits negative → excluded.
    expect(modelMatchesPatternList("claude-haiku-4-5", ["claude-*", "!vendor-alias"], "vendor-alias")).toBe(false)
  })
  test("empty-string family is ignored (legacy truthiness parity)", () => {
    // Candidate set uses `family ? [id, family] : [id]` to mirror legacy: an empty-string family must
    // NOT become a match candidate. Isolate with an empty entry (only "" would match ""): after the
    // fix, family "" is dropped so nothing spuriously matches → false, exactly like legacy.
    expect(modelMatchesPatternList("gpt-4", [""], "")).toBe(false)
    expect(modelMatchesPatternList("gpt-4", [""], "")).toBe(legacyMatch("gpt-4", [""], ""))
    // A real (non-empty) family candidate still participates.
    expect(modelMatchesPatternList("vendor-alias", ["claude-*"], "claude-opus-4-6")).toBe(true)
  })

  test("equivalence oracle: no-! no-glob inputs match frozen legacy impl", () => {
    const ids = ["claude-opus-4-8", "claude-opus-40", "claude-sonnet-4-5", "gpt-4", "claude-haiku-4-5"]
    const prefixLists = [["claude-opus-4"], ["claude-sonnet-4", "claude-haiku-4-5"], ["claude-opus-4-8"]]
    for (const id of ids) {
      for (const list of prefixLists) {
        expect(modelMatchesPatternList(id, list)).toBe(legacyMatch(id, list))
        expect(modelMatchesPatternList(id, list, "claude-opus-4-6")).toBe(legacyMatch(id, list, "claude-opus-4-6"))
      }
    }
  })
})

describe("matchesModelKey (substring for plain, anchored glob for meta)", () => {
  test("plain key keeps substring includes", () => {
    expect(matchesModelKey("claude-opus-4-7-high", "claude-opus-4-7")).toBe(true) // substring, keeps -high variant
    expect(matchesModelKey("claude-opus-4-8", "claude-opus-4-7")).toBe(false)
  })
  test("glob key → anchored glob", () => {
    expect(matchesModelKey("claude-opus-4-8", "claude-*")).toBe(true)
    expect(matchesModelKey("xclaude", "claude-*")).toBe(false) // anchored, not substring
  })
  test("normalizes spelling", () => {
    expect(matchesModelKey("claude-opus-4.8", "claude-opus-4-8")).toBe(true)
  })
})
