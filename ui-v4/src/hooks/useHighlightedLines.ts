import type { HighlighterCore } from "@shikijs/core"

import {
  //
  useEffect,
  useMemo,
  useState,
} from "react"

import type { HighlightLine } from "@/lib/highlight/shiki"

import {
  //
  getHighlighter,
  getLoadedHighlighter,
  highlightToLines,
  plaintextLines,
  themeNameForPreset,
} from "@/lib/highlight/shiki"
import { useUiStore } from "@/stores/ui-store"

/**
 * Bridge the async shiki highlighter singleton to React.
 *
 * shiki's grammars/themes load asynchronously, so the first CodeBlock renders
 * plaintext for one frame then re-renders highlighted once the shared singleton
 * resolves. Every subsequent block highlights immediately via the cached
 * singleton (`getLoadedHighlighter`), so there is no flash after the first load.
 *
 * The active `colorPreset` picks the baked syntax theme (amber ↔ neutral) — it's
 * a `useMemo` dep, so switching preset re-highlights every mounted block. shiki
 * bakes colors into inline styles in JS (they can't ride the CSS-var cascade like
 * the `--content-*` tokens), which is why the theme choice flows through here at
 * the React edge rather than living in the design-agnostic `shiki.ts` module.
 *
 * The `cancelled` guard prevents a setState-after-unmount when a component
 * unmounts before the highlighter promise resolves (no leak).
 */
export function useHighlightedLines(code: string, lang: string): Array<HighlightLine> {
  const [highlighter, setHighlighter] = useState<HighlighterCore | undefined>(() => getLoadedHighlighter())
  const colorPreset = useUiStore((s) => s.colorPreset)

  useEffect(() => {
    if (highlighter) return
    let cancelled = false
    void getHighlighter().then((loaded) => {
      if (!cancelled) setHighlighter(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [highlighter])

  return useMemo<Array<HighlightLine>>(
    () => (highlighter ? highlightToLines(highlighter, code, lang, themeNameForPreset(colorPreset)) : plaintextLines(code)),
    [highlighter, code, lang, colorPreset],
  )
}
