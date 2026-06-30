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

/**
 * Canonical repair-item set — also the fixed cascade order. The comma-separated config
 * `anthropic.tool_repair_malformed_input` is a SUBSET of these; enabling an item applies its
 * transform, cascaded in THIS order regardless of config spelling (`"jsonrepair,tags"` and
 * `"tags,jsonrepair"` behave identically). Order is the dependency order: `tags` (antml-tag strip)
 * runs before `jsonrepair` (structural repair) so jsonrepair won't trip over leaked tags.
 *
 * Item → layer/telemetry name: `tags`→`strip`, `jsonrepair`→`jsonrepair` (the layer name is the
 * repair MECHANISM name, which differs from the config ITEM name only for `tags`/`strip`).
 */
export const REPAIR_ITEMS = ["tags", "jsonrepair"] as const
export type RepairItem = (typeof REPAIR_ITEMS)[number]

/** Outcome of a layered repair attempt. `layer` names which layer produced the fix. */
export type RepairResult = { repaired: unknown; layer: "strip" | "jsonrepair" } | { unrepairable: true }

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
 * Cascade the enabled repair `items` (in canonical {@link REPAIR_ITEMS} order) over a malformed
 * tool_use input JSON string. Each enabled item applies its transform to the running `current`
 * string — so items **stack** (e.g. `tags`-strip THEN `jsonrepair` on the stripped form) — and
 * re-validates; the first item whose result parses AND is a plausible tool input (a JSON object)
 * wins, returning the parsed object with its layer name. `{ unrepairable: true }` when no enabled
 * item yields valid JSON. Idempotent on already-valid input (each layer is a no-op on well-formed
 * JSON). The caller decides forward-as-is vs fail on an unrepairable result.
 *
 * `tags`-only ≡ the legacy `"tags"` tier; `["tags","jsonrepair"]` ≡ the legacy `"repair"` tier
 * (jsonrepair on the stripped form). Decoupled items also allow new combinations the tiers
 * couldn't express (e.g. `jsonrepair` without `tags`).
 */
export function repairToolInput(raw: string, items: ReadonlyArray<RepairItem>): RepairResult {
  let current = raw

  if (items.includes("tags")) {
    current = stripAntmlTagsOutsideStrings(current)
    const afterStrip = parseJsonOrFail(current)
    if (afterStrip.ok && isPlausibleToolInput(afterStrip.value)) return { repaired: afterStrip.value, layer: "strip" }
  }

  if (items.includes("jsonrepair")) {
    const repaired = tryJsonRepair(current)
    if (repaired !== undefined) {
      const parsed = JSON.parse(repaired) as unknown
      if (isPlausibleToolInput(parsed)) return { repaired: parsed, layer: "jsonrepair" }
    }
  }

  return { unrepairable: true }
}
