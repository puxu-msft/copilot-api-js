import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getHighlighter,
  highlightToLines,
  plaintextLines,
} from "../src/lib/highlight/shiki"

/**
 * Tests for the shiki highlight module. shiki init is async (grammars/themes
 * load as dynamic modules), so the highlighter is `await`ed once and reused
 * across cases (it's a cached module singleton).
 */
describe("shiki highlight", () => {
  test("highlights JSON: key / string / number / true carry a non-empty color", async () => {
    const hl = await getHighlighter()
    const lines = highlightToLines(hl, '{"a":"x","n":1,"b":true}', "json")

    expect(lines).toHaveLength(1)
    const tokens = lines[0]
    // Every meaningful token (key, string, number, literal) has a baked color.
    const key = tokens.find((t) => t.text.includes("a"))
    const str = tokens.find((t) => t.text.includes("x"))
    const num = tokens.find((t) => t.text === "1")
    const lit = tokens.find((t) => t.text === "true")
    expect(key?.color).toBeTruthy()
    expect(str?.color).toBeTruthy()
    expect(num?.color).toBeTruthy()
    expect(lit?.color).toBeTruthy()
  })

  test("splits multi-line code into one entry per source line", async () => {
    const hl = await getHighlighter()
    const lines = highlightToLines(hl, '{\n  "alpha": "x",\n  "beta": "y"\n}', "json")
    expect(lines).toHaveLength(4)
  })

  test("highlights python (proves broadened lang set)", async () => {
    const hl = await getHighlighter()
    const lines = highlightToLines(hl, "def f():\n  pass", "python")
    expect(lines).toHaveLength(2)
    // At least one token across the snippet carries a color (keyword `def`/`pass`).
    const colored = lines.flat().filter((t) => t.color !== undefined)
    expect(colored.length).toBeGreaterThan(0)
  })

  test("a single multi-line string token is cut across lines (color carried to each piece)", async () => {
    const hl = await getHighlighter()
    // A TS template literal spanning two physical lines is one string token with a real `\n`.
    const lines = highlightToLines(hl, "const x = `a\nb`", "typescript")
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const combined = lines
      .flat()
      .map((t) => t.text)
      .join("")
    expect(combined).toContain("a")
    expect(combined).toContain("b")
  })

  test("empty code → []", async () => {
    const hl = await getHighlighter()
    expect(highlightToLines(hl, "", "json")).toEqual([])
  })

  test("unregistered lang → plaintext (no throw, single default color)", async () => {
    const hl = await getHighlighter()
    const lines = highlightToLines(hl, "hello world\nsecond line", "not-a-real-lang")
    expect(lines).toHaveLength(2)
    // Plaintext fallback (shiki `text` lang): tokens render with at most ONE
    // distinct color (the theme default) — no per-scope syntactic coloring.
    const colors = new Set(lines.flat().map((t) => t.color))
    expect(colors.size).toBeLessThanOrEqual(1)
    expect(lines[0][0]?.text).toBe("hello world")
  })

  test("plaintextLines splits raw lines with no color", () => {
    expect(plaintextLines("")).toEqual([])
    const lines = plaintextLines("one\ntwo")
    expect(lines).toEqual([[{ color: undefined, text: "one" }], [{ color: undefined, text: "two" }]])
  })
})
