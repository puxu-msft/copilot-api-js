/**
 * `truncateToWidth` — plain-text, display-width-aware truncation used by the
 * ConsoleSink footer. Iterates by code point (never splits surrogate pairs)
 * and reserves 1 column for the `…` ellipsis so the result is always
 * `≤ maxCols` display columns.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import { truncateToWidth } from "~/lib/observability/projections/format"

describe("truncateToWidth", () => {
  test("string shorter than the budget is returned unchanged (no ellipsis)", () => {
    expect(truncateToWidth("hello", 20)).toBe("hello")
  })

  test("string exactly at the budget is returned unchanged", () => {
    expect(truncateToWidth("hello", 5)).toBe("hello")
  })

  test("over-budget ASCII is truncated with an ellipsis, width ≤ maxCols", () => {
    const out = truncateToWidth("hello world", 8)
    expect(out.endsWith("…")).toBe(true)
    expect(stringWidth(out)).toBeLessThanOrEqual(8)
  })

  test("wide (CJK) chars count as width 2 and are never split", () => {
    // Each CJK char is width 2. Budget 5 → ellipsis(1) leaves 4 → two chars.
    const out = truncateToWidth("你好世界", 5)
    expect(stringWidth(out)).toBeLessThanOrEqual(5)
    expect(out).toBe("你好…")
  })

  test("emoji (surrogate pair) is dropped whole, never split mid-pair", () => {
    // "a😀b😀c😀" — emoji width 2, total width 9. Budget 4 → ellipsis(1) leaves
    // 3 → "a"(1)+"😀"(2)=3, next "b" would exceed → "a😀…". A mid-pair split
    // would instead yield a lone surrogate (width 0/broken); the exact-string
    // assertion proves the whole code point was kept or dropped.
    const out = truncateToWidth("a😀b😀c😀", 4)
    expect(out).toBe("a😀…")
    expect(stringWidth(out)).toBeLessThanOrEqual(4)
  })

  test("maxCols <= 0 clamps to empty string (an ellipsis alone would violate ≤ maxCols)", () => {
    expect(truncateToWidth("hello", 0)).toBe("")
    expect(truncateToWidth("hello", -3)).toBe("")
  })

  test("empty input returns empty", () => {
    expect(truncateToWidth("", 10)).toBe("")
  })
})
