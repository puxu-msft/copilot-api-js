import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  AMBER_THEME_NAME,
  getHighlighter,
  highlightToLines,
  NEUTRAL_THEME_NAME,
  themeNameForPreset,
} from "@/lib/highlight/shiki"

/**
 * C2 shiki dual-theme golden. shiki bakes token colors into inline hex at
 * highlight time (they can't ride the CSS-var cascade like the `--content-*`
 * tokens), so the highlighter registers BOTH the amber + neutral themes and each
 * `highlightToLines` call selects one by name (via {@link themeNameForPreset}
 * from the active `colorPreset`).
 *
 * These are the golden baked-hex values captured against a fixed JSON sample:
 *   - AMBER leg is the INV-3 pixel-equivalence proof — the amber theme was NOT
 *     touched by C2 and remains the default, so these bytes equal the pre-C2
 *     highlight output. (Independent oracle for the amber palette:
 *     `src/lib/highlight/amber-theme.ts`, uppercased by shiki.)
 *   - NEUTRAL leg proves the second theme is registered + selectable and yields a
 *     distinct cool palette (oracle: `src/lib/highlight/neutral-theme.ts`).
 *
 * A pure bun test (no jsdom / snapshot file) — the highlighter is deterministic,
 * so exact hex assertions are a stable golden without snapshot flakiness.
 */

const SAMPLE = '{"a":"x","n":1,"b":true}'

/** Extract the baked color of the key / string / number / literal tokens. */
function bakedColors(tokens: Array<{ color: string | undefined; text: string }>) {
  return {
    key: tokens.find((t) => t.text.includes("a"))?.color,
    str: tokens.find((t) => t.text.includes("x"))?.color,
    num: tokens.find((t) => t.text === "1")?.color,
    lit: tokens.find((t) => t.text === "true")?.color,
  }
}

describe("shiki dual-theme selection", () => {
  test("themeNameForPreset maps colorPreset → theme name", () => {
    expect(themeNameForPreset("amber")).toBe(AMBER_THEME_NAME)
    expect(themeNameForPreset("neutral")).toBe(NEUTRAL_THEME_NAME)
    expect(AMBER_THEME_NAME).toBe("terminal-amber")
    expect(NEUTRAL_THEME_NAME).toBe("neutral-syntax")
  })

  test("amber theme bakes the unchanged Terminal Amber palette (INV-3)", async () => {
    const hl = await getHighlighter()
    const tokens = highlightToLines(hl, SAMPLE, "json", AMBER_THEME_NAME)[0]
    expect(bakedColors(tokens)).toEqual({
      key: "#D4A04A",
      str: "#9FBF7A",
      num: "#D4A04A",
      lit: "#9A8AD0",
    })
  })

  test("default (no theme arg) stays amber — bare callers byte-identical", async () => {
    const hl = await getHighlighter()
    const withDefault = highlightToLines(hl, SAMPLE, "json")[0]
    const withAmber = highlightToLines(hl, SAMPLE, "json", AMBER_THEME_NAME)[0]
    expect(withDefault).toEqual(withAmber)
  })

  test("neutral theme bakes a distinct cool palette", async () => {
    const hl = await getHighlighter()
    const tokens = highlightToLines(hl, SAMPLE, "json", NEUTRAL_THEME_NAME)[0]
    expect(bakedColors(tokens)).toEqual({
      key: "#7DD3FC",
      str: "#A3D1A5",
      num: "#93C5FD",
      lit: "#C4B5FD",
    })
  })
})
