import type { ThemeRegistration } from "@shikijs/core"

/**
 * Neutral "zinc / blue-white" shiki theme — the design-neutral counterpart to
 * {@link AMBER_THEME}, selected when `colorPreset === "neutral"` (the shadcn
 * tree's default). Same scope coverage / structure as the amber theme (a
 * hand-written TextMate `ThemeRegistration`), only the palette differs: cool
 * zinc/slate neutrals + sky/blue/violet accents, cohesive with the `neutral`
 * preset's `--content-*` token family in `theme.css`.
 *
 * shiki bakes the token color into each token span's inline `style="color:#..."`
 * (no token CSS classes), so — unlike the CSS-var content tokens that resolve via
 * the DOM cascade — the highlighter must pick a theme in JS at highlight time.
 * `useHighlightedLines` reads the active `colorPreset` and passes the matching
 * theme name, so switching preset re-highlights every code block.
 *
 * Palette (on the neutral near-black code background `#0a0a0c`, mirroring the
 * amber theme's scope map value-for-value):
 * - default text  `#e4e4e7`  zinc-200 (--content-text neutral)
 * - string        `#a3d1a5`  soft cool green
 * - number        `#93c5fd`  blue-300 (--content-accent neutral)
 * - keyword/lit    `#c4b5fd`  violet-300 (--content-thinking neutral)
 * - comment       `#71717a`  zinc-500 (--content-dim neutral), italic
 * - key/property  `#7dd3fc`  sky-300 (--content-number neutral)
 * - function      `#93c5fd`  blue-300
 * - variable      `#d4d4d8`  zinc-300
 * - punctuation   `#8a8a94`  dim
 */
export const NEUTRAL_THEME: ThemeRegistration = {
  name: "neutral-syntax",
  type: "dark",
  colors: {
    "editor.foreground": "#e4e4e7",
    "editor.background": "#0a0a0c",
  },
  tokenColors: [
    {
      scope: ["string", "string.quoted", "constant.character", "constant.other.symbol"],
      settings: { foreground: "#a3d1a5" },
    },
    {
      scope: ["constant.numeric"],
      settings: { foreground: "#93c5fd" },
    },
    {
      scope: ["constant.language", "keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new"],
      settings: { foreground: "#c4b5fd" },
    },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#71717a", fontStyle: "italic" },
    },
    {
      // JSON keys + object properties + tag names.
      scope: ["support.type.property-name", "meta.object-literal.key", "entity.name.tag", "variable.other.property", "support.type.property-name.json"],
      settings: { foreground: "#7dd3fc" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
      settings: { foreground: "#93c5fd" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter"],
      settings: { foreground: "#d4d4d8" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.definition"],
      settings: { foreground: "#8a8a94" },
    },
  ],
}
