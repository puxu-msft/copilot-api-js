/**
 * Pure-logic tests for the resizable-width clamp (CONTRACT with the TOC sidebar
 * drag handle). Pointer-drag interaction is covered in TocSidebar.vitest.test.tsx
 * (jsdom); here we lock the bound arithmetic independent of the DOM.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  clampWidth,
  TOC_WIDTH_DEFAULT,
  TOC_WIDTH_MAX,
  TOC_WIDTH_MIN,
} from "@/hooks/useResizableWidth"

describe("clampWidth", () => {
  test("passes through a value inside the range", () => {
    expect(clampWidth(300)).toBe(300)
    expect(clampWidth(TOC_WIDTH_DEFAULT)).toBe(TOC_WIDTH_DEFAULT)
  })

  test("clamps below-min up to the min bound", () => {
    expect(clampWidth(TOC_WIDTH_MIN - 1)).toBe(TOC_WIDTH_MIN)
    expect(clampWidth(0)).toBe(TOC_WIDTH_MIN)
    expect(clampWidth(-9999)).toBe(TOC_WIDTH_MIN)
  })

  test("clamps above-max down to the max bound", () => {
    expect(clampWidth(TOC_WIDTH_MAX + 1)).toBe(TOC_WIDTH_MAX)
    expect(clampWidth(99999)).toBe(TOC_WIDTH_MAX)
  })

  test("returns exactly the inclusive bounds", () => {
    expect(clampWidth(TOC_WIDTH_MIN)).toBe(TOC_WIDTH_MIN)
    expect(clampWidth(TOC_WIDTH_MAX)).toBe(TOC_WIDTH_MAX)
  })

  test("NaN falls back to min; infinities clamp to their bounds", () => {
    expect(clampWidth(Number.NaN)).toBe(TOC_WIDTH_MIN)
    expect(clampWidth(Number.POSITIVE_INFINITY)).toBe(TOC_WIDTH_MAX)
    expect(clampWidth(Number.NEGATIVE_INFINITY)).toBe(TOC_WIDTH_MIN)
  })

  test("honors explicit custom bounds", () => {
    expect(clampWidth(50, 10, 40)).toBe(40)
    expect(clampWidth(5, 10, 40)).toBe(10)
    expect(clampWidth(25, 10, 40)).toBe(25)
  })

  test("bound constants are sane (min < default < max)", () => {
    expect(TOC_WIDTH_MIN).toBeLessThan(TOC_WIDTH_DEFAULT)
    expect(TOC_WIDTH_DEFAULT).toBeLessThan(TOC_WIDTH_MAX)
    expect(TOC_WIDTH_MIN).toBe(140)
    expect(TOC_WIDTH_MAX).toBe(520)
    expect(TOC_WIDTH_DEFAULT).toBe(200)
  })
})
