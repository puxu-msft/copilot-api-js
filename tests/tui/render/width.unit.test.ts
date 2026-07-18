import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import {
  //
  truncateAnsiToWidth,
  truncateToWidth,
} from "~/lib/tui/render/width"

describe("truncateToWidth", () => {
  test("returns shorter and exact-budget strings unchanged", () => {
    expect(truncateToWidth("hello", 20)).toBe("hello")
    expect(truncateToWidth("hello", 5)).toBe("hello")
  })

  test("truncates over-budget ASCII with an ellipsis", () => {
    const out = truncateToWidth("hello world", 8)
    expect(out).toBe("hello w…")
    expect(stringWidth(out)).toBeLessThanOrEqual(8)
  })

  test("keeps wide CJK and single-code-point emoji whole", () => {
    expect(truncateToWidth("你好世界", 5)).toBe("你好…")
    expect(truncateToWidth("a😀b😀c😀", 4)).toBe("a😀…")
  })

  test.each([
    ["keycap", "1️⃣x", 2],
    ["flag", "🇨🇳x", 2],
    ["skin tone", "👍🏽x", 2],
    ["ZWJ family", "👨‍👩‍👧‍👦x", 2],
    ["combining mark", "e\u0301x", 1],
  ])("%s grapheme clusters are kept whole and never exceed the budget", (_label, input, maxCols) => {
    const out = truncateToWidth(input, maxCols)
    expect(out).toBe("…")
    expect(stringWidth(out)).toBeLessThanOrEqual(maxCols)
  })

  test("display-width invariant holds across mixed Unicode and every narrow budget", () => {
    const input = "A1️⃣🇨🇳👍🏽👨‍👩‍👧‍👦e\u0301你好😀Z"
    for (let maxCols = 0; maxCols <= stringWidth(input) + 2; maxCols++) {
      const out = truncateToWidth(input, maxCols)
      expect(stringWidth(out)).toBeLessThanOrEqual(maxCols)
      if (out.endsWith("…")) expect(input.startsWith(out.slice(0, -1))).toBe(true)
    }
  })

  test("non-positive budgets clamp to empty and empty input stays empty", () => {
    expect(truncateToWidth("hello", 0)).toBe("")
    expect(truncateToWidth("hello", -3)).toBe("")
    expect(truncateToWidth("", 10)).toBe("")
  })
})

describe("truncateAnsiToWidth", () => {
  test("returns styled content unchanged when it fits", () => {
    const styled = "\x1b[7m1️⃣\x1b[27m"
    expect(truncateAnsiToWidth(styled, 2)).toBe(styled)
  })

  test("closes SGR before the ellipsis and never splits a grapheme", () => {
    const out = truncateAnsiToWidth("\x1b[7m1️⃣1️⃣x\x1b[27m", 3)
    expect(out).toBe("\x1b[7m1️⃣\x1b[27m…")
    expect(stringWidth(out)).toBe(3)
  })

  test("closes OSC 8 hyperlinks before the ellipsis", () => {
    const out = truncateAnsiToWidth("\x1b]8;;https://example.com\x07hello\x1b]8;;\x07", 4)
    expect(out).toBe("\x1b]8;;https://example.com\x07hel\x1b]8;;\x07…")
    expect(stringWidth(out)).toBe(4)
  })

  test("styled mixed-Unicode width invariant holds across every budget", () => {
    const styled = "\x1b[2mA1️⃣🇨🇳👍🏽👨‍👩‍👧‍👦e\u0301你好😀Z\x1b[22m"
    for (let maxCols = 0; maxCols <= stringWidth(styled) + 2; maxCols++) {
      expect(stringWidth(truncateAnsiToWidth(styled, maxCols))).toBeLessThanOrEqual(maxCols)
    }
  })

  test.each(["♠", "♣", "♥", "♦", "☺", "❤"])("canonical width postcondition survives slice-ansi disagreement for %s", (character) => {
    const styled = `\x1b[2m${character.repeat(3)}\x1b[22m`
    for (let maxCols = 1; maxCols <= stringWidth(styled) + 1; maxCols++) {
      expect(stringWidth(truncateAnsiToWidth(styled, maxCols))).toBeLessThanOrEqual(maxCols)
    }
  })

  test("canonical width postcondition survives mixed ASCII and ambiguous symbols under ANSI", () => {
    const styled = "\x1b[1mA♠B♥C♦\x1b[22m"
    for (let maxCols = 1; maxCols <= stringWidth(styled) + 1; maxCols++) {
      expect(stringWidth(truncateAnsiToWidth(styled, maxCols))).toBeLessThanOrEqual(maxCols)
    }
  })
})
