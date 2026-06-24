import type { ThemeRegistration } from "@shikijs/core"

/**
 * Industrial "Terminal Amber" shiki theme.
 *
 * A hand-written TextMate `ThemeRegistration` mapping the main scopes to the
 * existing Terminal Amber palette (mirrors the old `.hljs-*` rules that lived in
 * `theme.css`). shiki bakes the token color into each token span's inline
 * `style="color:#..."` (no token CSS classes), so this object is the single
 * source of truth for highlight colors.
 *
 * Coverage is deliberately compact but spans BOTH the dominant content (JSON:
 * keys / strings / numbers / true-false-null / punctuation) AND the common code
 * scopes (keywords, comments, functions, properties) so the broadened language
 * set still renders meaningfully.
 *
 * Palette (from `theme.css` tokens, on the near-black code background `#100e0b`):
 * - default text  `#d8cdbb`  (--color-text)
 * - string        `#9fbf7a`  warm olive (desaturated --color-ok)
 * - number        `#d4a04a`  amber (--color-primary)
 * - keyword/lit   `#9a8ad0`  soft purple
 * - comment       `#8a7a55`  muted (--color-muted), italic
 * - key/property  `#d4a04a`  amber
 * - function      `#d4a04a`  amber
 * - variable      `#cdbf9a`  light warm
 * - punctuation   `#9a8f78`  dim
 */
export const AMBER_THEME: ThemeRegistration = {
  name: "terminal-amber",
  type: "dark",
  colors: {
    "editor.foreground": "#d8cdbb",
    "editor.background": "#100e0b",
  },
  tokenColors: [
    {
      scope: ["string", "string.quoted", "constant.character", "constant.other.symbol"],
      settings: { foreground: "#9fbf7a" },
    },
    {
      scope: ["constant.numeric"],
      settings: { foreground: "#d4a04a" },
    },
    {
      scope: ["constant.language", "keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new"],
      settings: { foreground: "#9a8ad0" },
    },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8a7a55", fontStyle: "italic" },
    },
    {
      // JSON keys + object properties + tag names.
      scope: ["support.type.property-name", "meta.object-literal.key", "entity.name.tag", "variable.other.property", "support.type.property-name.json"],
      settings: { foreground: "#d4a04a" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
      settings: { foreground: "#d4a04a" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter"],
      settings: { foreground: "#cdbf9a" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.definition"],
      settings: { foreground: "#9a8f78" },
    },
  ],
}
