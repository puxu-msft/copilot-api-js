/**
 * Unit tests for rewrite rule compilation: compileRewriteRule / compileRewriteRules.
 */

import { describe, expect, test } from "bun:test"

import { compileRewriteRule, compileRewriteRules, type RewriteRule } from "~/lib/config/config"

// ============================================================================
// compileRewriteRule
// ============================================================================

describe("compileRewriteRule", () => {
  test("compiles regex rule with gms flags", () => {
    const result = compileRewriteRule({ from: "foo.*bar", to: "baz" })
    expect(result).not.toBeNull()
    expect(result!.method).toBe("regex")
    expect(result!.from).toBeInstanceOf(RegExp)
    const re = result!.from as RegExp
    expect(re.global).toBe(true)
    expect(re.multiline).toBe(true)
    expect(re.dotAll).toBe(true)
  })

  test("defaults method to regex when not specified", () => {
    const result = compileRewriteRule({ from: "hello", to: "world" })
    expect(result!.method).toBe("regex")
    expect(result!.from).toBeInstanceOf(RegExp)
  })

  test("line method keeps from as string", () => {
    const result = compileRewriteRule({ from: "exact match", to: "replaced", method: "line" })
    expect(result).not.toBeNull()
    expect(result!.method).toBe("line")
    expect(typeof result!.from).toBe("string")
    expect(result!.from).toBe("exact match")
  })

  test("preserves to string", () => {
    const result = compileRewriteRule({ from: "a", to: "$1 replacement" })
    expect(result!.to).toBe("$1 replacement")
  })

  test("returns null for invalid regex", () => {
    const result = compileRewriteRule({ from: "[invalid(", to: "x", method: "regex" })
    expect(result).toBeNull()
  })

  // --- inline flag parsing ---

  test("strips (?s) inline flag and merges with base gms flags", () => {
    const result = compileRewriteRule({ from: "(?s).*", to: "" })
    expect(result).not.toBeNull()
    const re = result!.from as RegExp
    expect(re.source).toBe(".*")
    expect(re.dotAll).toBe(true) // s flag (already in base, no duplicate)
    expect(re.global).toBe(true)
    expect(re.multiline).toBe(true)
  })

  test("strips (?i) and adds case-insensitive flag", () => {
    const result = compileRewriteRule({ from: "(?i)hello", to: "world" })
    expect(result).not.toBeNull()
    const re = result!.from as RegExp
    expect(re.source).toBe("hello")
    expect(re.ignoreCase).toBe(true)
    expect(re.global).toBe(true)
  })

  test("strips (?im) and merges multiple flags", () => {
    const result = compileRewriteRule({ from: "(?im)^line$", to: "replaced" })
    expect(result).not.toBeNull()
    const re = result!.from as RegExp
    expect(re.source).toBe("^line$")
    expect(re.ignoreCase).toBe(true)
    expect(re.multiline).toBe(true) // m already in base
  })

  test("no inline flags leaves pattern unchanged", () => {
    const result = compileRewriteRule({ from: "plain pattern", to: "" })
    expect(result).not.toBeNull()
    expect((result!.from as RegExp).source).toBe("plain pattern")
  })
})

// ============================================================================
// compileRewriteRules
// ============================================================================

describe("compileRewriteRules", () => {
  test("compiles all valid rules", () => {
    const raws: Array<RewriteRule> = [
      { from: "a", to: "b", method: "regex" },
      { from: "c", to: "d", method: "line" },
    ]
    const compiled = compileRewriteRules(raws)
    expect(compiled).toHaveLength(2)
    expect(compiled[0].from).toBeInstanceOf(RegExp)
    expect(compiled[1].from).toBe("c")
  })

  test("skips invalid regex rules", () => {
    const raws: Array<RewriteRule> = [
      { from: "valid", to: "ok" },
      { from: "[bad(", to: "skip" },
      { from: "also-valid", to: "ok" },
    ]
    const compiled = compileRewriteRules(raws)
    expect(compiled).toHaveLength(2)
    expect((compiled[0].from as RegExp).source).toBe("valid")
    expect((compiled[1].from as RegExp).source).toBe("also-valid")
  })

  test("returns empty array for empty input", () => {
    expect(compileRewriteRules([])).toEqual([])
  })

  test("returns empty array when all rules are invalid", () => {
    const compiled = compileRewriteRules([
      { from: "[bad(", to: "x" },
      { from: "(?P<named>)", to: "y" },
    ])
    expect(compiled).toEqual([])
  })
})
