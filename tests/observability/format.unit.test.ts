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
import pc from "picocolors"
import stringWidth from "string-width"

import {
  //
  formatCacheRate,
  formatNumber,
  truncateToWidth,
} from "~/lib/observability/projections/format"

/** Strip SGR color codes so assertions target the plain rendered text. */
// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

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

describe("formatNumber (compact token unit)", () => {
  test("sub-thousand values are shown verbatim", () => {
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(456)).toBe("456")
    expect(formatNumber(999)).toBe("999")
  })

  test("thousands use a lowercase 'k' suffix with one decimal", () => {
    expect(formatNumber(1000)).toBe("1.0k")
    expect(formatNumber(8000)).toBe("8.0k")
    expect(formatNumber(12_345)).toBe("12.3k")
  })

  test("millions use a lowercase 'm' suffix with one decimal", () => {
    expect(formatNumber(1_000_000)).toBe("1.0m")
    expect(formatNumber(1_500_000)).toBe("1.5m")
  })
})

describe("formatCacheRate", () => {
  test("no cache activity (read and creation both 0/undefined) renders empty", () => {
    expect(formatCacheRate(1000, 0, 0)).toBe("")
    expect(formatCacheRate(1000, undefined, undefined)).toBe("")
    expect(formatCacheRate(undefined, undefined, undefined)).toBe("")
  })

  test("zero total (all fields 0) renders empty — no divide-by-zero", () => {
    expect(formatCacheRate(0, 0, 0)).toBe("")
  })

  test("hit% = read/total; new% = creation/total over input+read+creation", () => {
    // input=1000 (net fresh) + read=8000 (hit) + creation=1000 (first write) = 10000
    expect(stripAnsi(formatCacheRate(1000, 8000, 1000))).toBe("↻80%+10%")
  })

  test("creation omitted when zero — only the hit marker is shown", () => {
    // input=2000 + read=8000 = 10000 → 80% hit, no new-cache segment
    expect(stripAnsi(formatCacheRate(2000, 8000, 0))).toBe("↻80%")
  })

  test("read=0 with creation>0 shows a 0% hit plus the new-cache segment", () => {
    // input=9000 + creation=1000 = 10000 → 0% hit, 10% newly written
    expect(stripAnsi(formatCacheRate(9000, 0, 1000))).toBe("↻0%+10%")
  })

  test("percentages are rounded to the nearest integer", () => {
    // total = 3 → read 1/3 = 33.3% → 33
    expect(stripAnsi(formatCacheRate(2, 1, 0))).toBe("↻33%")
    // total = 1 → read 1/1 = 100%
    expect(stripAnsi(formatCacheRate(0, 1, 0))).toBe("↻100%")
  })

  test("the hit segment is dim and the new-cache segment is cyan (color parity with the token column)", () => {
    // Parity assertion built through picocolors itself, so it holds whether or
    // not the test env has color enabled (both sides render identically).
    expect(formatCacheRate(1000, 8000, 1000)).toBe(`${pc.dim("↻80%")}${pc.cyan("+10%")}`)
  })
})
