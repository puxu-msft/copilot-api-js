import type {
  //
  KeyboardEvent,
  ReactNode,
} from "react"

import {
  //
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type { HighlightToken } from "@/lib/highlight/shiki"

import { LineGutter } from "@/components/detail/LineNumberedText"
import { useHighlightedLines } from "@/hooks/useHighlightedLines"
import { copyText } from "@/lib/clipboard"

interface CodeBlockProps {
  code: string
  /** shiki language id. Defaults to `"json"` (the JSON callers); unregistered langs fall back to plaintext. */
  lang?: string
  /**
   * Render an optional control row above the code: copy, soft-wrap toggle, and
   * line-level search (highlight matching lines + prev/next jump). Defaults to
   * `false` so the existing bare callers stay byte-identical.
   */
  toolbar?: boolean
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

const CONTROL_BTN = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)]"

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
 *
 * With `toolbar`, a control row is added: copy (reuses `copyText`), a soft-wrap
 * toggle (`whitespace-pre` ↔ `whitespace-pre-wrap`), and LINE-LEVEL search
 * (matching lines are highlighted; prev/next cycle + scroll the active match into
 * view). Search is per-line — not cross-token substring — because shiki has
 * already split each line into independent colored spans.
 */
export function CodeBlock({ code, lang = "json", toolbar = false }: CodeBlockProps) {
  const lines = useHighlightedLines(code, lang)
  const lineNodes = useMemo<Array<ReactNode>>(() => lines.map((tokens, i) => renderLine(tokens, i)), [lines])

  // Toolbar-only ephemeral state. Hooks are declared unconditionally (before the
  // no-toolbar early return) so hook order stays stable; they are inert when off.
  const [wrap, setWrap] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIdx, setActiveIdx] = useState(0)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const prevQueryRef = useRef(query)

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // Search line-text is derived from the SAME `lines` the gutter renders (not a second
  // `code.split("\n")`) so match/jump indices can never drift from the gutter rows —
  // shiki normalizes a trailing newline, so an independent split would desync by one.
  const lineTexts = useMemo<Array<string>>(() => lines.map((tokens) => tokens.map((t) => t.text).join("")), [lines])

  // Line-level match: 0-based indices of source lines containing the (case-insensitive) query.
  const matches = useMemo<Array<number>>(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const out: Array<number> = []
    for (const [i, line] of lineTexts.entries()) {
      if (line.toLowerCase().includes(q)) out.push(i)
    }
    return out
  }, [query, lineTexts])

  // Reset the active pointer to the first match on query change — done during render
  // (store-previous pattern) rather than in an effect, so we never commit a frame that
  // scrolls toward the stale match before the reset lands.
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query
    if (activeIdx !== 0) setActiveIdx(0)
  }

  const highlightLines = useMemo(() => new Set(matches), [matches])
  const activePos = matches.length > 0 ? Math.min(activeIdx, matches.length - 1) : 0
  const activeLine = matches.length > 0 ? matches[activePos] : undefined

  const onCopy = async () => {
    const ok = await copyText(code)
    setCopied(ok)
    if (ok) {
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }
  }

  const step = (delta: number) => {
    if (matches.length === 0) return
    setActiveIdx((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "Enter": {
        e.preventDefault()
        step(e.shiftKey ? -1 : 1)
        break
      }
      case "ArrowDown": {
        e.preventDefault()
        step(1)
        break
      }
      case "ArrowUp": {
        e.preventDefault()
        step(-1)
        break
      }
      default: {
        break
      }
    }
  }

  if (!toolbar) {
    return (
      <div className="border-l-2 border-[var(--color-border)] bg-[#100e0b] px-2 py-1">
        <LineGutter lines={lineNodes} />
      </div>
    )
  }

  return (
    <div
      className="border-l-2 border-[var(--color-border)] bg-[#100e0b]"
      data-soft-wrap={String(wrap)}
    >
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-1">
        <button
          type="button"
          onClick={onCopy}
          className={`${CONTROL_BTN} ${copied ? "text-[var(--color-ok)]" : ""}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className={`${CONTROL_BTN} ${wrap ? "text-[var(--color-primary)]" : ""}`}
        >
          Wrap: {wrap ? "on" : "off"}
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search lines…"
          aria-label="Search lines"
          className="mono ml-2 min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
        />
        {query.trim().length > 0 ?
          <>
            <span className="mono w-[4.5em] flex-shrink-0 text-center text-[12px] text-[var(--color-muted)]">
              {matches.length > 0 ? `${activePos + 1}/${matches.length}` : "0/0"}
            </span>
            <button
              type="button"
              aria-label="Previous match"
              onClick={() => step(-1)}
              className={CONTROL_BTN}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next match"
              onClick={() => step(1)}
              className={CONTROL_BTN}
            >
              ↓
            </button>
          </>
        : null}
      </div>
      <div className={`px-2 py-1 ${wrap ? "" : "overflow-x-auto"}`}>
        <LineGutter
          lines={lineNodes}
          wrap={wrap}
          highlightLines={highlightLines}
          activeLine={activeLine}
        />
      </div>
    </div>
  )
}
