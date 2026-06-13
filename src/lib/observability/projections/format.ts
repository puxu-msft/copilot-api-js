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

/** Compact integer with K/M suffix. */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
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

/** Streaming progress footer fragment: ` ↓12.3KB 42ev [thinking]`. */
export function formatStreamInfo(args: { bytesIn?: number; eventsIn?: number; blockType?: string }): string {
  if (args.bytesIn === undefined) return ""
  const bytes = formatBytes(args.bytesIn)
  const events = args.eventsIn ?? 0
  const blockType = args.blockType ? ` [${args.blockType}]` : ""
  return ` ↓${bytes} ${events}ev${blockType}`
}
