/**
 * Pure formatting helpers shared across observability sinks.
 *
 * These were originally in `src/lib/tui/format.ts` and live here because
 * (a) multiple sinks need them (ConsoleSink for stdout rendering, future
 * file/OTLP exporters for diagnostic text), and (b) the formatting layer
 * should not depend on `TuiLogEntry` — the old type couples display to
 * the legacy logger. Here, each helper takes primitives and returns
 * strings; the sink decides what to do with them.
 *
 * `formatBillingLabel` still reads `state.tokenBasedBilling` because the
 * decision "show multiplier badge or not" is account-wide and not carried
 * on each event. The other helpers are pure.
 */

import pc from "picocolors"
import stringWidth from "string-width"

import { state } from "~/lib/state"

/**
 * Per-model billing badge: ` (${multiplier}x)` for legacy multiplier
 * accounts, `""` on token-based-billing accounts where the badge would be
 * uniform noise. Returns the leading space so callers can unconditionally
 * concatenate.
 */
export function formatBillingLabel(multiplier: number | undefined): string {
  if (state.tokenBasedBilling) return ""
  if (multiplier === undefined) return ""
  return ` (${multiplier}x)`
}

/** HH:MM:SS, padded. */
export function formatTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

/** Sub-second precision under 1s; one-decimal seconds otherwise. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Compact integer with a lowercase k/m suffix. */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Compact byte count with KB/MB suffix. */
export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

/**
 * Token-count column: `↑<input>+<cacheRead>+<cacheCreation> ↓<output>`.
 * Cache breakdowns are dim/cyan to deemphasize relative to fresh tokens.
 */
export function formatTokens(input?: number, output?: number, cacheRead?: number, cacheCreation?: number): string {
  if (input === undefined && output === undefined) return "-"
  let result = `↑${formatNumber(input ?? 0)}`
  if (cacheRead) result += pc.dim(`+${formatNumber(cacheRead)}`)
  if (cacheCreation) result += pc.cyan(`+${formatNumber(cacheCreation)}`)
  result += ` ↓${formatNumber(output ?? 0)}`
  return result
}

/**
 * Prompt-cache rate marker: `↻<hit%>+<new%>` where
 *   hit% = cacheRead / (input + cacheRead + cacheCreation)   — dim (served from cache)
 *   new% = cacheCreation / (input + cacheRead + cacheCreation) — cyan (written this request)
 *
 * The denominator is total billed input; `input` here is the NET fresh count,
 * disjoint from the cache fields (see request/usage-normalize.ts), so the three
 * sum to total input. Coloring mirrors {@link formatTokens} (cache read dim,
 * cache creation cyan). Returns `""` when there is no cache activity (both cache
 * fields 0/undefined). The `+new%` segment is only appended when
 * `cacheCreation > 0`.
 */
export function formatCacheRate(input?: number, cacheRead?: number, cacheCreation?: number): string {
  const read = cacheRead ?? 0
  const creation = cacheCreation ?? 0
  if (read === 0 && creation === 0) return ""
  const total = (input ?? 0) + read + creation
  // Defensive: the guard above already forces total > 0 (read + creation ≥ 1,
  // token counts non-negative), but keep the divide-by-zero belt if that guard
  // is ever relaxed.
  if (total === 0) return ""
  const hitPct = Math.round((read / total) * 100)
  let result = pc.dim(`↻${hitPct}%`)
  if (creation > 0) {
    const newPct = Math.round((creation / total) * 100)
    result += pc.cyan(`+${newPct}%`)
  }
  return result
}

/** Streaming progress footer fragment: ` ↓12.3KB 42ev [thinking]`. */
export function formatStreamInfo(args: { bytesIn?: number; eventsIn?: number; blockType?: string }): string {
  if (args.bytesIn === undefined) return ""
  const bytes = formatBytes(args.bytesIn)
  const events = args.eventsIn ?? 0
  const blockType = args.blockType ? ` [${args.blockType}]` : ""
  return ` ↓${bytes} ${events}ev${blockType}`
}

/**
 * Truncate a **plain-text** (no ANSI) string to a display width of at most
 * `maxCols` columns, appending `…` (width 1) when characters are dropped.
 *
 * Iterates by Unicode code point (`for...of`) so surrogate pairs (emoji) and
 * combining sequences are never split mid-character; a wide (CJK/emoji, width
 * 2) character is dropped whole if it would exceed the budget rather than
 * leaving half a glyph. Reserves 1 column for the ellipsis, so the returned
 * width is guaranteed `≤ maxCols`.
 *
 * Callers must pass plain text — the function counts display width and slices
 * on code points, so an ANSI escape would be measured as width 0 but could be
 * cut mid-sequence. The footer applies its single `pc.dim` wrap *after* this.
 *
 * Degenerate `maxCols <= 0` clamps to `""` (an ellipsis alone is width 1 and
 * would violate the `≤ maxCols` contract).
 */
export function truncateToWidth(plain: string, maxCols: number): string {
  if (maxCols <= 0) return ""
  const total = stringWidth(plain)
  if (total <= maxCols) return plain

  // Must truncate — reserve 1 column for the ellipsis.
  const budget = maxCols - 1
  let width = 0
  let out = ""
  for (const ch of plain) {
    const w = stringWidth(ch)
    if (width + w > budget) break
    width += w
    out += ch
  }
  return out + "…"
}
