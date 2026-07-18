import sliceAnsi from "slice-ansi"
import stringWidth from "string-width"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Truncate plain text to at most `maxCols` terminal display columns and append
 * an ellipsis when content is dropped. Segmentation follows Unicode grapheme
 * boundaries, so combining marks, flags, keycaps, emoji modifiers, and ZWJ
 * sequences are never split.
 */
export function truncateToWidth(plain: string, maxCols: number): string {
  if (maxCols <= 0) return ""
  if (stringWidth(plain) <= maxCols) return plain

  const budget = maxCols - 1
  let width = 0
  let out = ""
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > budget) break
    width += segmentWidth
    out += segment
  }
  return `${out}…`
}

/**
 * ANSI-aware counterpart to {@link truncateToWidth}. SGR and OSC hyperlink
 * state is kept syntactically complete by `slice-ansi`; visible text is sliced
 * only at grapheme boundaries. The ellipsis is emitted after any closing ANSI
 * sequence returned by the slicer, so truncation cannot leak styling into the
 * following terminal output.
 */
export function truncateAnsiToWidth(styled: string, maxCols: number): string {
  if (maxCols <= 0) return ""
  if (stringWidth(styled) <= maxCols) return styled

  const budget = maxCols - 1
  let prefix = sliceAnsi(styled, 0, budget)
  if (stringWidth(prefix) > budget) {
    // `slice-ansi` and our canonical `string-width` can disagree on East Asian
    // ambiguous characters (for example, ♠). Preserve slice-ansi's ANSI state
    // machine, but binary-search its slice coordinate until the canonical
    // display-width postcondition is satisfied. The visible width of a prefix
    // is monotonically non-decreasing as the slice coordinate grows.
    let low = 0
    let high = budget - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = sliceAnsi(styled, 0, middle)
      if (stringWidth(candidate) <= budget) {
        prefix = candidate
        low = middle + 1
      } else high = middle - 1
    }
  }
  return `${prefix}…`
}
