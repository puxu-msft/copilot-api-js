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

/** True for a single hex digit. Hand-rolled (not regex) to stay safe on out-of-range `undefined`. */
function isHexChar(c: string | undefined): boolean {
  if (c === undefined || c.length !== 1) return false
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
}

/** True for the whitespace that may break a `\uXXXX` escape (space / tab / CR / LF). */
function isEscapeBreakWhitespace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n"
}

/**
 * `unicode` item — conservative whitespace-broken `\uXXXX` escape repair.
 *
 * Upstream (opus-4.8) occasionally emits a `\uXXXX` escape with whitespace splitting the four hex
 * digits — e.g. `默` as `\u9 ed8` (real capture req_1782778207147_144) — which makes the whole
 * stringified JSON invalid at that escape. This removes ONLY whitespace that falls **between** hex
 * digits when doing so yields exactly four (e.g. `\u9 ed8` → `默`). It is deliberately narrow:
 * a legal `\uXXXX` is passed through byte-identical, and an escape that is NOT a clean
 * whitespace-broken-quad — whitespace right after `\u`, fewer than four hex digits, or a non-hex
 * character — is left untouched (legal JSON never has whitespace inside a `\u` escape, so the
 * mis-repair surface is ≈0). Single forward pass with backslash-escape tracking so a non-`\u`
 * escape (`\n`, `\"`, `\\`) is never re-scanned as the start of a `\u`.
 */
export function fixBadUnicodeEscapes(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    if (input[i] === "\\" && input[i + 1] === "u") {
      // Already-valid `\uXXXX` (four hex immediately after) → pass through untouched.
      if (isHexChar(input[i + 2]) && isHexChar(input[i + 3]) && isHexChar(input[i + 4]) && isHexChar(input[i + 5])) {
        out += input.slice(i, i + 6)
        i += 6
        continue
      }
      // Collect exactly four hex digits, skipping ONLY whitespace BETWEEN digits (the first char
      // after `\u` must be hex — whitespace immediately after `\u` is left alone, conservative).
      if (isHexChar(input[i + 2])) {
        const hexes = [input[i + 2]]
        let j = i + 3
        let consumedWhitespace = false
        while (j < n && hexes.length < 4) {
          const c = input[j]
          if (isHexChar(c)) {
            hexes.push(c)
            j++
          } else if (isEscapeBreakWhitespace(c)) {
            consumedWhitespace = true
            j++
          } else {
            break
          }
        }
        if (hexes.length === 4 && consumedWhitespace) {
          out += `\\u${hexes.join("")}`
          i = j
          continue
        }
      }
      // Not a repairable whitespace-broken escape → emit the `\u` verbatim and advance past it.
      out += input.slice(i, i + 2)
      i += 2
      continue
    }
    if (input[i] === "\\") {
      // A non-`\u` backslash escape (`\n`, `\"`, `\\`): copy both bytes so the escaped char is
      // never re-interpreted as the start of a `\u` scan.
      out += input.slice(i, i + 2)
      i += 2
      continue
    }
    out += input[i]
    i++
  }
  return out
}

/**
 * Best-effort (LOSSY) `\uXXXX` escape repair — last resort for escapes a hex digit was DROPPED from.
 *
 * `fixBadUnicodeEscapes` (lossless) can only rescue whitespace-SPLIT escapes that still carry four
 * hex digits (`\u9 ed8` → `默`). Real opus-4.8 captures also drop a digit outright — `\u9 44`
 * (a space plus only THREE hex) — which is fundamentally unrecoverable (the missing nibble is
 * unknowable). This pass converts each un-completable `\u…` run into a single U+FFFD replacement
 * character so the surrounding JSON becomes valid, at the cost of one garbled glyph. It is strictly
 * more aggressive than the lossless pass:
 *   - four hex digits recoverable (skipping any whitespace, INCLUDING a leading space `\u 9ed8`)
 *     → emit the clean `\uXXXX` escape (no loss).
 *   - fewer than four hex digits before a non-hex terminator → emit U+FFFD, keep the terminator.
 * A legal `\uXXXX` and a non-`\u` backslash escape (`\n`, `\"`, `\\`) pass through byte-identical.
 * Idempotent: a U+FFFD it introduced is a plain char with no `\u`, never re-scanned.
 */
export function fixBadUnicodeEscapesLossy(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    if (input[i] === "\\" && input[i + 1] === "u") {
      // Already-valid `\uXXXX` (four hex immediately after) → pass through untouched.
      if (isHexChar(input[i + 2]) && isHexChar(input[i + 3]) && isHexChar(input[i + 4]) && isHexChar(input[i + 5])) {
        out += input.slice(i, i + 6)
        i += 6
        continue
      }
      // Collect up to four hex digits from after `\u`, skipping ANY whitespace (including a leading
      // space, unlike the conservative lossless pass which requires the first char to be hex).
      const hexes: Array<string> = []
      let j = i + 2
      while (j < n && hexes.length < 4) {
        const c = input[j]
        if (isHexChar(c)) {
          hexes.push(c)
          j++
        } else if (isEscapeBreakWhitespace(c)) {
          j++
        } else {
          break
        }
      }
      if (hexes.length === 4) {
        // Four digits recovered → clean escape, no loss.
        out += `\\u${hexes.join("")}`
        i = j
        continue
      }
      // Fewer than four hex digits available → un-completable. Replace the whole broken `\u…` run
      // (the `\u` marker plus any hex/whitespace we consumed) with a single U+FFFD; keep the
      // terminator at `j`. Advance past at least `\u` so the scan always makes progress.
      out += "�"
      i = Math.max(j, i + 2)
      continue
    }
    if (input[i] === "\\") {
      // A non-`\u` backslash escape (`\n`, `\"`, `\\`): copy both bytes so the escaped char is
      // never re-interpreted as the start of a `\u` scan.
      out += input.slice(i, i + 2)
      i += 2
      continue
    }
    out += input[i]
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

/**
 * Canonical repair-item set — also the fixed cascade order. The comma-separated config
 * `anthropic.tool_repair_malformed_input` is a SUBSET of these; enabling an item applies its
 * transform, cascaded in THIS order regardless of config spelling (`"jsonrepair,tags"` and
 * `"tags,jsonrepair"` behave identically). Order is the dependency order: `tags` (antml-tag strip)
 * → `unicode` (whitespace-broken `\uXXXX` escape fix) → `jsonrepair` (structural repair) →
 * `unicode-lossy` (best-effort lossy `\uXXXX` fix); the cheaper / more-targeted / LOSSLESS fixes
 * run first so the broad heuristic (jsonrepair) and finally the LOSSY last resort (`unicode-lossy`,
 * which garbles ≥1 char) only run when everything non-destructive has failed.
 *
 * Item → layer/telemetry name: `tags`→`strip`, `unicode`→`unicode`, `jsonrepair`→`jsonrepair`,
 * `unicode-lossy`→`unicode-lossy` (the layer name is the repair MECHANISM name, which differs from
 * the config ITEM name only for `tags`/`strip`).
 */
export const REPAIR_ITEMS = ["tags", "unicode", "jsonrepair", "unicode-lossy"] as const
export type RepairItem = (typeof REPAIR_ITEMS)[number]

/** Outcome of a layered repair attempt. `layer` names which layer produced the fix. */
export type RepairResult = { repaired: unknown; layer: "strip" | "unicode" | "jsonrepair" | "unicode-lossy" } | { unrepairable: true }

function parseJsonOrFail(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/**
 * A tool_use `input` is ALWAYS a JSON object (the tool's argument map). Gating on this rejects
 * jsonrepair's aggressive fabrications — e.g. `jsonrepair("not json")` → the bare string
 * `"not json"`, which parses but is a meaningless tool input (audit H3). A bare string / number /
 * array / null repaired result is treated as unrepairable rather than forwarded as a "success".
 */
function isPlausibleToolInput(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Field-level gate: accepts a JSON object OR array. Used when repairing a stringified decode-target
 * FIELD (e.g. AskUserQuestion `questions`, which is legitimately an array) rather than a whole tool
 * input. Still rejects jsonrepair's scalar fabrications (bare string/number/null) — only object/array
 * are structured JSON a field could plausibly hold.
 */
function isPlausibleObjectOrArray(v: unknown): boolean {
  return typeof v === "object" && v !== null
}

/** Options for {@link repairToolInput}. */
export interface RepairToolInputOptions {
  /**
   * Accept a repaired ARRAY as success, not just an object. Set when repairing a stringified
   * decode-target field whose expected shape is an array (AskUserQuestion `questions`). The default
   * (false) keeps the object-only gate for whole-input repair, where a bare array is not a valid tool
   * argument map. In BOTH modes a bare scalar (string/number/null) is still rejected.
   */
  allowArrayResult?: boolean
}

/**
 * Cascade the enabled repair `items` (in canonical {@link REPAIR_ITEMS} order) over a malformed
 * tool_use input JSON string. Each enabled item applies its transform to the running `current`
 * string — so items **stack** (e.g. `tags`-strip THEN `jsonrepair` on the stripped form) — and
 * re-validates; the first item whose result parses AND is a plausible tool input (a JSON object,
 * or object/array when `opts.allowArrayResult`) wins, returning the parsed value with its layer
 * name. `{ unrepairable: true }` when no enabled item yields valid JSON. Idempotent on already-valid
 * input (each layer is a no-op on well-formed JSON). The caller decides forward-as-is vs fail on an
 * unrepairable result.
 *
 * `tags`-only ≡ the legacy `"tags"` tier; `["tags","jsonrepair"]` ≡ the legacy `"repair"` tier
 * (jsonrepair on the stripped form). Decoupled items also allow new combinations the tiers
 * couldn't express (e.g. `jsonrepair` without `tags`).
 */
export function repairToolInput(raw: string, items: ReadonlyArray<RepairItem>, opts: RepairToolInputOptions = {}): RepairResult {
  const plausible = opts.allowArrayResult ? isPlausibleObjectOrArray : isPlausibleToolInput
  let current = raw

  if (items.includes("tags")) {
    current = stripAntmlTagsOutsideStrings(current)
    const afterStrip = parseJsonOrFail(current)
    if (afterStrip.ok && plausible(afterStrip.value)) return { repaired: afterStrip.value, layer: "strip" }
  }

  if (items.includes("unicode")) {
    current = fixBadUnicodeEscapes(current)
    const afterUnicode = parseJsonOrFail(current)
    if (afterUnicode.ok && plausible(afterUnicode.value)) return { repaired: afterUnicode.value, layer: "unicode" }
  }

  if (items.includes("jsonrepair")) {
    const repaired = tryJsonRepair(current)
    if (repaired !== undefined) {
      const parsed = JSON.parse(repaired) as unknown
      if (plausible(parsed)) return { repaired: parsed, layer: "jsonrepair" }
    }
  }

  if (items.includes("unicode-lossy")) {
    // LAST resort — lossy. Replace un-completable `\uXXXX` escapes with U+FFFD, then re-run
    // jsonrepair for any residual structural issue on the now-lossy string. Only reached when every
    // non-destructive item above failed; costs ≥1 garbled glyph but rescues an otherwise-dead input.
    current = fixBadUnicodeEscapesLossy(current)
    const afterLossy = parseJsonOrFail(current)
    if (afterLossy.ok && plausible(afterLossy.value)) return { repaired: afterLossy.value, layer: "unicode-lossy" }
    const repaired = tryJsonRepair(current)
    if (repaired !== undefined) {
      const parsed = JSON.parse(repaired) as unknown
      if (plausible(parsed)) return { repaired: parsed, layer: "unicode-lossy" }
    }
  }

  return { unrepairable: true }
}
