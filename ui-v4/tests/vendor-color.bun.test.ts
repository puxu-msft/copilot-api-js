/**
 * Pure-logic tests for the Models table's vendor-color chip. Asserts the
 * hex color mapping (semantics aligned to the Vue `vendorColor`: anthropic →
 * purple, openai/azure → blue, google → green, other → pink, none → muted),
 * matched case-insensitively by substring so `"Anthropic"` and `"anthropic"`
 * resolve identically.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { vendorColor } from "@/lib/vendor-color"

describe("vendorColor", () => {
  test("known vendors → semantic hex", () => {
    expect(vendorColor("Anthropic")).toBe("#b48ead")
    expect(vendorColor("OpenAI")).toBe("#5aa2d0")
    expect(vendorColor("Azure")).toBe("#5aa2d0")
    expect(vendorColor("Google")).toBe("#8fbf7f")
  })

  test("case-insensitive substring match", () => {
    expect(vendorColor("anthropic")).toBe("#b48ead")
    expect(vendorColor("Azure OpenAI")).toBe("#5aa2d0")
    expect(vendorColor("Google DeepMind")).toBe("#8fbf7f")
  })

  test("unknown → pink", () => {
    expect(vendorColor("xAI")).toBe("#d08fb4")
    expect(vendorColor("Mistral")).toBe("#d08fb4")
  })

  test("empty / undefined → muted", () => {
    expect(vendorColor(undefined)).toBe("var(--color-muted)")
    expect(vendorColor("")).toBe("var(--color-muted)")
  })
})
