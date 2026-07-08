import type { ReactNode } from "react"

import {
  //
  useEffect,
  useRef,
  useState,
} from "react"

/**
 * Per-line left-gutter line numbering, pure CSS (no external deps).
 *
 * Ported from the old Vue `LineNumberPre.vue`: each line is a row with a
 * right-aligned dim line-number cell + a content cell. Large texts (>500 lines)
 * are truncated by default with a "show all" button to avoid thousands of DOM
 * nodes on first render.
 *
 * Composition: `LineGutter` is the reusable shell that lays out already-rendered
 * per-line nodes (so Task 3's CodeBlock can pass highlighted token spans through
 * the SAME gutter), and `LineNumberedText` is a thin wrapper that splits plain
 * text into string lines and feeds them to `LineGutter`.
 */

const INITIAL_LINE_LIMIT = 500

/** Amber row background for a search match — stronger for the active jump target, softer for other matches, none otherwise. */
function rowHighlightClass(isActive: boolean, isMatch: boolean): string {
  if (isActive) return "bg-[color-mix(in_srgb,var(--color-primary)_28%,transparent)]"
  if (isMatch) return "bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]"
  return ""
}

interface LineGutterProps {
  /** Already-rendered per-line content nodes (one entry per source line). */
  lines: Array<ReactNode>
  className?: string
  /** 0-based source-line indices to visually highlight (line-level search matches). */
  highlightLines?: Set<number>
  /** 0-based index of the active match — emphasized + scrolled into view. */
  activeLine?: number
  /** Content wrapping: `true` (default) soft-wraps long lines; `false` keeps `whitespace-pre` (caller scrolls horizontally). */
  wrap?: boolean
}

/** Numbered-line layout primitive. Renders a 1-based gutter beside the provided per-line nodes, with >500-line truncation + show-all. */
export function LineGutter({ lines, className, highlightLines, activeLine, wrap = true }: LineGutterProps) {
  const [showAll, setShowAll] = useState(false)
  const activeRef = useRef<HTMLDivElement | null>(null)

  const total = lines.length
  // A search jump can target a line past the truncation window; reveal all so the row exists to scroll to.
  const forceShowAll = activeLine !== undefined && activeLine >= INITIAL_LINE_LIMIT
  const effectiveShowAll = showAll || forceShowAll
  const isTruncated = !effectiveShowAll && total > INITIAL_LINE_LIMIT
  const visible = isTruncated ? lines.slice(0, INITIAL_LINE_LIMIT) : lines
  const hiddenCount = total - INITIAL_LINE_LIMIT

  // Scroll the active search match into view whenever it changes (jsdom stubs scrollIntoView; see tests/setup.ts).
  useEffect(() => {
    if (activeLine !== undefined) activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeLine])

  const contentWrap = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"

  return (
    <div className={`mono text-[13px] leading-[1.5] ${className ?? ""}`}>
      {visible.map((node, i) => {
        const isMatch = highlightLines?.has(i) ?? false
        const isActive = activeLine === i
        return (
          <div
            key={i}
            ref={isActive ? activeRef : undefined}
            data-line-match={isMatch ? "" : undefined}
            data-line-active={isActive ? "" : undefined}
            className={`flex ${rowHighlightClass(isActive, isMatch)}`}
          >
            <span className="w-[3.5em] flex-shrink-0 select-none pr-2 text-right text-[var(--color-muted)] opacity-60">{i + 1}</span>
            <span className={`min-w-0 flex-1 ${contentWrap} border-l border-[var(--color-border)] pl-2`}>{node}</span>
          </div>
        )
      })}
      {isTruncated ?
        <div className="mt-1 border-t border-dashed border-[var(--color-border)] py-1 text-center">
          <button
            type="button"
            className="cursor-pointer text-[12px] text-[var(--color-primary)] hover:underline"
            onClick={() => setShowAll(true)}
          >
            显示全部 {total} 行（隐藏 {hiddenCount} 行）
          </button>
        </div>
      : null}
    </div>
  )
}

interface LineNumberedTextProps {
  text: string
  className?: string
}

/** Plain-text line numbering. Splits `text` on `\n` and renders each line through `LineGutter` (React-escaped text, no dangerouslySetInnerHTML). */
export function LineNumberedText({ text, className }: LineNumberedTextProps) {
  const lines = text.split("\n").map((line) => (line.length > 0 ? line : "​"))
  return (
    <LineGutter
      lines={lines}
      className={className}
    />
  )
}
