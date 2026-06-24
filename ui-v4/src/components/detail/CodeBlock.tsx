import type { ReactNode } from "react"

import { useMemo } from "react"

import type { HighlightToken } from "@/lib/highlight/shiki"

import { LineGutter } from "@/components/detail/LineNumberedText"
import { useHighlightedLines } from "@/hooks/useHighlightedLines"

interface CodeBlockProps {
  code: string
  /** shiki language id. Defaults to `"json"` (the JSON callers); unregistered langs fall back to plaintext. */
  lang?: string
}

/** Render one highlighted line's tokens as `<span>`s. Empty line → zero-width space so the gutter row keeps its height. */
function renderLine(tokens: Array<HighlightToken>, lineIndex: number): ReactNode {
  if (tokens.length === 0) return "​"
  return tokens.map((token, i) => (
    <span
      key={`${lineIndex}:${i}`}
      style={token.color ? { color: token.color } : undefined}
    >
      {token.text}
    </span>
  ))
}

/**
 * Syntax-highlighted code with line numbers, themed to industrial Terminal Amber.
 *
 * shiki (VS Code TextMate grammars → hast AST) is flattened to per-line token
 * arrays and rendered as React `<span style={{ color }}>`s carrying the inline
 * color baked by the custom amber theme — NO `dangerouslySetInnerHTML`. Because
 * shiki initializes asynchronously, the first block renders plaintext for one
 * frame then re-renders highlighted (subsequent blocks highlight immediately via
 * the cached singleton). Line numbers + >500 truncation are reused from the
 * shared `LineGutter`.
 */
export function CodeBlock({ code, lang = "json" }: CodeBlockProps) {
  const lines = useHighlightedLines(code, lang)
  const lineNodes = useMemo<Array<ReactNode>>(() => lines.map((tokens, i) => renderLine(tokens, i)), [lines])

  return (
    <div className="border-l-2 border-[var(--color-border)] bg-[#100e0b] px-2 py-1">
      <LineGutter lines={lineNodes} />
    </div>
  )
}
