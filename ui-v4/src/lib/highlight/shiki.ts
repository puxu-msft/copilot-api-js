import type {
  //
  HighlighterCore,
  LanguageInput,
} from "@shikijs/core"
import type {
  //
  Element,
  ElementContent,
  Root,
  RootContent,
} from "hast"

import { createHighlighterCore } from "@shikijs/core"
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript"

import { AMBER_THEME } from "@/lib/highlight/amber-theme"

/**
 * shiki-based syntax highlighter (replaces the old lowlight/highlight.js path).
 *
 * shiki is more powerful than highlight.js — it uses VS Code TextMate grammars
 * and themes, covering far more languages. Unlike hljs (which tags tokens with a
 * `hljs-*` className), shiki bakes the token color into each token span's inline
 * `style="color:#..."`. So this module keeps the SAME per-line token concept but
 * each token carries `color?: string` instead of a className. The CodeBlock
 * component renders those tokens as React `<span style={{ color }}>` — there is
 * no `dangerouslySetInnerHTML` anywhere.
 *
 * `codeToHast` returns a hast `Root`: `root → <pre> → <code> → per-line
 * <span class="line"> → token <span style="color:#...">`, with `"\n"` text nodes
 * between line spans. We flatten that tree (reading `properties.style`) into a
 * flat token list then split on `\n` into per-line token arrays (so a single
 * multi-line token — a multi-line string/comment — carries its color onto each
 * line piece, identical to the old behavior).
 *
 * The highlighter is created ONCE, lazily, as a module singleton (its init is
 * async because grammars/themes load as dynamic modules). After the first load,
 * `getLoadedHighlighter()` returns the resolved instance so later blocks can
 * highlight synchronously without a plaintext flash.
 */

/** The custom theme's `name`, passed to `codeToHast`. */
const THEME_NAME = AMBER_THEME.name ?? "terminal-amber"

/**
 * Broad set of common languages registered up-front (each a dynamic grammar
 * module under `@shikijs/langs/<id>`). All ids verified to resolve against the
 * installed `@shikijs/langs` package. `bash` covers shell; `dockerfile`/`docker`
 * resolve to the same grammar.
 */
const LANG_LOADERS: Array<() => Promise<{ default: LanguageInput }>> = [
  () => import("@shikijs/langs/json"),
  () => import("@shikijs/langs/jsonc"),
  () => import("@shikijs/langs/javascript"),
  () => import("@shikijs/langs/typescript"),
  () => import("@shikijs/langs/jsx"),
  () => import("@shikijs/langs/tsx"),
  () => import("@shikijs/langs/bash"),
  () => import("@shikijs/langs/python"),
  () => import("@shikijs/langs/go"),
  () => import("@shikijs/langs/rust"),
  () => import("@shikijs/langs/java"),
  () => import("@shikijs/langs/c"),
  () => import("@shikijs/langs/cpp"),
  () => import("@shikijs/langs/ruby"),
  () => import("@shikijs/langs/php"),
  () => import("@shikijs/langs/diff"),
  () => import("@shikijs/langs/yaml"),
  () => import("@shikijs/langs/toml"),
  () => import("@shikijs/langs/sql"),
  () => import("@shikijs/langs/html"),
  () => import("@shikijs/langs/css"),
  () => import("@shikijs/langs/markdown"),
  () => import("@shikijs/langs/dockerfile"),
  () => import("@shikijs/langs/ini"),
  () => import("@shikijs/langs/xml"),
]

/** A single highlighted token: inline color (or undefined for un-scoped text) + its raw text slice. */
export interface HighlightToken {
  /** Inline color (e.g. `"#d4a04a"`) from shiki's token style, or `undefined` for un-scoped (default) text. */
  color: string | undefined
  text: string
}

/** One source line = an ordered list of tokens. */
export type HighlightLine = Array<HighlightToken>

let highlighterPromise: Promise<HighlighterCore> | undefined
let loadedHighlighter: HighlighterCore | undefined

/** Lazily create (once) and cache the shared highlighter. The promise is cached so concurrent callers share one init. */
export function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === undefined) {
    highlighterPromise = (async () => {
      const langModules = await Promise.all(LANG_LOADERS.map((load) => load()))
      const langs = langModules.map((mod) => mod.default)
      const highlighter = await createHighlighterCore({
        themes: [AMBER_THEME],
        langs,
        engine: createJavaScriptRegexEngine(),
      })
      loadedHighlighter = highlighter
      return highlighter
    })()
  }
  return highlighterPromise
}

/** The resolved highlighter if it has already loaded, else `undefined` (lets components highlight synchronously after the first load). */
export function getLoadedHighlighter(): HighlighterCore | undefined {
  return loadedHighlighter
}

/** Parse a single CSS `color:VALUE` declaration out of a hast token's `properties.style`. shiki emits exactly `color:#...`. */
function colorFromStyle(style: Element["properties"]["style"]): string | undefined {
  if (typeof style !== "string") return undefined
  const match = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)
  return match ? match[1].trim() : undefined
}

/** Depth-first flatten of the hast tree into a flat token list, carrying the nearest ancestor's color to each text leaf. */
function flatten(nodes: Array<RootContent> | Array<ElementContent>, inheritedColor: string | undefined, out: Array<HighlightToken>): void {
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value.length > 0) out.push({ color: inheritedColor, text: node.value })
      continue
    }
    if (node.type === "element") {
      const ownColor = colorFromStyle(node.properties.style) ?? inheritedColor
      flatten(node.children, ownColor, out)
    }
    // Other hast content kinds (comment/doctype) never appear in highlight output → ignored.
  }
}

/**
 * Split a flat token list into per-line token arrays. A token containing `\n` is
 * cut across lines, carrying its color to each piece. (shiki also separates line
 * spans with explicit `"\n"` text nodes — those drive the same split.)
 */
function splitIntoLines(tokens: Array<HighlightToken>): Array<HighlightLine> {
  let current: HighlightLine = []
  const lines: Array<HighlightLine> = [current]
  for (const token of tokens) {
    const pieces = token.text.split("\n")
    for (const [i, piece] of pieces.entries()) {
      if (i > 0) {
        current = []
        lines.push(current)
      }
      if (piece.length > 0) current.push({ color: token.color, text: piece })
    }
  }
  return lines
}

/** Raw lines with no color (the not-yet-loaded fallback, or a defensive fallback when highlighting fails). */
export function plaintextLines(code: string): Array<HighlightLine> {
  if (code.length === 0) return []
  return code.split("\n").map((line) => (line.length > 0 ? [{ color: undefined, text: line }] : []))
}

/**
 * Highlight `code` as `lang` into per-line token arrays using the (already
 * loaded) `highlighter`.
 *
 * Falls back to a plaintext rendering when `lang` is not registered, and to
 * raw-text-per-line if `codeToHast` throws for any reason (never crashes the
 * caller).
 */
export function highlightToLines(highlighter: HighlighterCore, code: string, lang: string): Array<HighlightLine> {
  if (code.length === 0) return []

  const language = highlighter.getLoadedLanguages().includes(lang) ? lang : "text"

  let root: Root
  try {
    root = highlighter.codeToHast(code, { lang: language, theme: THEME_NAME })
  } catch {
    return plaintextLines(code)
  }

  const flat: Array<HighlightToken> = []
  flatten(root.children, undefined, flat)
  return splitIntoLines(flat)
}
