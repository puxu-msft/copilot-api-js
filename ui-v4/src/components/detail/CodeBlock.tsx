import type { ReactNode } from "react"

import { useMemo } from "react"

import { LineGutter } from "@/components/detail/LineNumberedText"
import { highlightToLines } from "@/lib/highlight/lowlight"

interface CodeBlockProps {
  code: string
  /** highlight.js language id. Defaults to `"json"` (the JSON callers); unregistered langs fall back to plaintext. */
  lang?: string
}

/** Render one highlighted line's tokens as `<span>`s. Empty line → zero-width space so the gutter row keeps its height. */
function renderLine(tokens: Array<{ className: string | undefined; text: string }>, lineIndex: number): ReactNode {
  if (tokens.length === 0) return "​"
  return tokens.map((token, i) => (
    <span
      key={`${lineIndex}:${i}`}
      className={token.className}
    >
      {token.text}
    </span>
  ))
}

/**
 * Syntax-highlighted code with line numbers, themed to industrial Terminal Amber.
 *
 * lowlight (highlight.js → hast AST) is flattened to per-line token arrays and
 * rendered as React `<span>`s carrying the raw `hljs-*` class (styled in
 * `theme.css`) — NO `dangerouslySetInnerHTML`. Line numbers + >500 truncation
 * are reused from Task 2's `LineGutter`. Highlighting is memoized over
 * `code`+`lang` (pure).
 */
export function CodeBlock({ code, lang = "json" }: CodeBlockProps) {
  const lineNodes = useMemo<Array<ReactNode>>(() => highlightToLines(code, lang).map((tokens, i) => renderLine(tokens, i)), [code, lang])

  return (
    <div className="border-l-2 border-[var(--color-border)] bg-[#100e0b] px-2 py-1">
      <LineGutter lines={lineNodes} />
    </div>
  )
}
