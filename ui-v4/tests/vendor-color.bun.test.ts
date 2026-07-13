/**
 * Pure-logic tests for the Models table's vendor-color chip. Asserts the
 * `--vendor-*` SEMANTIC TOKEN mapping (semantics aligned to the Vue `vendorColor`:
 * anthropic → purple, openai/azure → blue, google → green, other → pink, none →
 * muted), matched case-insensitively by substring so `"Anthropic"` and
 * `"anthropic"` resolve identically.
 *
 * C2 neutralized this A′ builder from baked hex to design-neutral tokens: the
 * builder now emits `var(--vendor-*)` and the two presets (amber / neutral, in
 * theme.css) own the concrete color. The old hex→token equivalence (amber preset
 * resolves `--vendor-anthropic` back to `#b48ead`, etc.) is guarded by the
 * independent oracle `semantic-tokens.vitest.test.ts` (against theme.css), so
 * this file asserts the STABLE token contract, not a color value that moves per
 * preset.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { vendorColor } from "@/lib/vendor-color"

describe("vendorColor", () => {
  test("known vendors → semantic vendor token", () => {
    expect(vendorColor("Anthropic")).toBe("var(--vendor-anthropic)")
    expect(vendorColor("OpenAI")).toBe("var(--vendor-openai)")
    expect(vendorColor("Azure")).toBe("var(--vendor-openai)")
    expect(vendorColor("Google")).toBe("var(--vendor-google)")
  })

  test("case-insensitive substring match", () => {
    expect(vendorColor("anthropic")).toBe("var(--vendor-anthropic)")
    expect(vendorColor("Azure OpenAI")).toBe("var(--vendor-openai)")
    expect(vendorColor("Google DeepMind")).toBe("var(--vendor-google)")
  })

  test("unknown → other (pink)", () => {
    expect(vendorColor("xAI")).toBe("var(--vendor-other)")
    expect(vendorColor("Mistral")).toBe("var(--vendor-other)")
  })

  test("empty / undefined → muted", () => {
    expect(vendorColor(undefined)).toBe("var(--vendor-muted)")
    expect(vendorColor("")).toBe("var(--vendor-muted)")
  })
})
