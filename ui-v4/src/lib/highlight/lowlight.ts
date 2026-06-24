import type {
  //
  Element,
  ElementContent,
  Root,
  RootContent,
} from "hast"

import bash from "highlight.js/lib/languages/bash"
import json from "highlight.js/lib/languages/json"
import plaintext from "highlight.js/lib/languages/plaintext"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import { createLowlight } from "lowlight"

/**
 * Single shared lowlight instance with ONLY the languages we render
 * (json/typescript/bash/xml + plaintext fallback) registered, to keep the
 * highlight.js footprint small.
 *
 * lowlight v3 (`createLowlight`) returns a hast `Root` from `.highlight(lang,
 * code)` — a tree of `element`(span)/`text` nodes whose `properties.className`
 * carries the `hljs-*` token class. We flatten that tree to a flat token list
 * then split on `\n` into per-line token arrays (so a single multi-line token —
 * a multi-line string/comment — carries its class onto each line piece). The
 * CodeBlock component renders those tokens as React `<span>`s, so there is no
 * `dangerouslySetInnerHTML` anywhere.
 */
const lowlight = createLowlight()
lowlight.register({ bash, json, plaintext, typescript, xml })

/** A single highlighted token: leaf `hljs-*` class (or undefined for un-scoped text) + its raw text slice. */
export interface HighlightToken {
  /** Leaf hljs token class, e.g. `"hljs-string"`. `undefined` = un-scoped (default) text. */
  className: string | undefined
  text: string
}

/** One source line = an ordered list of tokens. */
export type HighlightLine = Array<HighlightToken>

/** Whether `lang` is registered (so `highlight` won't throw). Used to pick the plaintext fallback. */
function isRegistered(lang: string): boolean {
  return lowlight.registered(lang)
}

/** Pick the leaf `hljs-*` class from a hast element's className list (first entry is the prefixed token class). */
function leafClassName(node: Element): string | undefined {
  const className = node.properties.className
  if (Array.isArray(className) && className.length > 0) {
    const first = className[0]
    return typeof first === "string" ? first : undefined
  }
  return undefined
}

/** Depth-first flatten of the hast tree into a flat token list, carrying the nearest ancestor's leaf class to each text leaf. */
function flatten(nodes: Array<RootContent> | Array<ElementContent>, inheritedClass: string | undefined, out: Array<HighlightToken>): void {
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value.length > 0) out.push({ className: inheritedClass, text: node.value })
      continue
    }
    if (node.type === "element") {
      const ownClass = leafClassName(node) ?? inheritedClass
      flatten(node.children, ownClass, out)
    }
    // Other hast content kinds (comment/doctype) never appear in highlight output → ignored.
  }
}

/** Split a flat token list into per-line token arrays. A token containing `\n` is cut across lines, carrying its class to each piece. */
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
      if (piece.length > 0) current.push({ className: token.className, text: piece })
    }
  }
  return lines
}

/**
 * Highlight `code` as `lang` into per-line token arrays.
 *
 * Falls back to `plaintext` when `lang` is unregistered, and to a single
 * raw-text token per line if highlighting throws for any reason (never crashes
 * the caller).
 */
export function highlightToLines(code: string, lang: string): Array<HighlightLine> {
  if (code.length === 0) return []

  const language = isRegistered(lang) ? lang : "plaintext"

  let root: Root
  try {
    root = lowlight.highlight(language, code)
  } catch {
    // Defensive: unexpected grammar failure → render the raw code with no scopes.
    return code.split("\n").map((line) => (line.length > 0 ? [{ className: undefined, text: line }] : []))
  }

  const flat: Array<HighlightToken> = []
  flatten(root.children, undefined, flat)
  return splitIntoLines(flat)
}
