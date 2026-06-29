/**
 * Malformed `tool_use` input repair (Anthropic response wire).
 *
 * Upstream occasionally leaks the antml tool-call wrapper tags
 * (`<invoke …>`, `<parameter …>`, `</invoke>`, `</parameter>`) into the
 * streamed `tool_use` input JSON — e.g. a TodoWrite arg arriving as
 * `{"todos":[…]</parameter>\n</invoke>\n}`. The forwarded stream then carries
 * invalid JSON that the client's parser rejects. This module repairs the
 * forwarded payload only (History keeps the upstream-original bytes).
 */

import { jsonrepair } from "jsonrepair"

/**
 * Sticky matcher for an antml tool-call tag at a given offset:
 * `<invoke …>`, `<parameter …>`, `</invoke>`, `</parameter>`. The `\b` guards
 * against `<invoked>` / `<parameterize>`; `[^>]*` swallows any attributes
 * (and their quotes) so the scanner consumes the tag as one unit.
 */
const ANTML_TAG = /<\/?(?:invoke|parameter)\b[^>]*>/y

/**
 * Layer 1 — structure-aware antml-tag stripping.
 *
 * Removes antml tool-call tags that appear **outside** a JSON string literal
 * while leaving the identical byte sequence **inside** string values untouched
 * (so a legitimate value like `"close </parameter>"` survives). Single forward
 * pass with proper string/escape tracking; returns the input unchanged when no
 * out-of-string tag is present (idempotent on well-formed JSON).
 */
export function stripAntmlTagsOutsideStrings(input: string): string {
  let out = ""
  let inString = false
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    if (inString) {
      if (ch === "\\") {
        // Escaped char: copy both bytes verbatim, never interpret the next one.
        out += input.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === '"') inString = false
      out += ch
      i++
      continue
    }
    // Outside a string literal.
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === "<") {
      ANTML_TAG.lastIndex = i
      const m = ANTML_TAG.exec(input)
      if (m) {
        // Skip the whole tag (including any attribute quotes) without emitting it.
        i += m[0].length
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/**
 * Layer 2 — jsonrepair-backed structural repair.
 *
 * Runs `jsonrepair` (which completes missing brackets/quotes, fixes trailing
 * commas, etc.) over input that survived Layer 1 still malformed — e.g. a
 * structurally truncated tool arg missing its closing `]}`. Returns the
 * repaired string only when it re-parses as valid JSON, otherwise `undefined`.
 *
 * `jsonrepair` **throws** on inputs it cannot make sense of (notably antml tag
 * bleed → `JSONRepairError: Colon expected`), so the call is wrapped; the
 * re-parse gate additionally guards against a heuristic result that still isn't
 * valid JSON. jsonrepair preserves real (non-ASCII) characters verbatim — it
 * does not re-escape Chinese into `\uXXXX`.
 */
export function tryJsonRepair(input: string): string | undefined {
  try {
    const repaired = jsonrepair(input)
    JSON.parse(repaired) // re-parse gate: only return what genuinely parses
    return repaired
  } catch {
    return undefined
  }
}
