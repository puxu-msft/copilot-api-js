/**
 * Active-request footer rendering — pure builder extracted from `ConsoleSink`
 * (P0 terminal-layer reorg; behavior-equivalent to the former private
 * `buildFooter` + `buildModelGroupSegments` + `finalizeFooter` trio).
 *
 * The footer (`[<-->] ...`) is the live "in-flight requests" indicator drawn
 * below the log stream. This module owns the hard invariant it depends on:
 * **the footer is always ≤ 1 physical line** — see {@link finalizeFooter}.
 *
 * Purity: no `this`, no wall clock, no I/O. Callers supply the active-request
 * view, the current `now`, and the (already width-sanitized) `columns`.
 */

import pc from "picocolors"
import stringWidth from "string-width"

import type { RequestContextSnapshot } from "~/lib/observability"

import {
  //
  formatBytes,
  formatDuration,
  formatStreamInfo,
  truncateToWidth,
} from "~/lib/observability/projections/format"

/**
 * Read-only view of a single active request as the footer needs it. A projection
 * of `ConsoleSink`'s internal `ActiveRequest` — only the fields the footer reads.
 */
export interface ActiveRequestView {
  ctx: RequestContextSnapshot
  /** Streaming byte/event totals from `request.stream_progress`. */
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
}

/**
 * Build the active-request footer as a finalized (`pc.dim` + width-truncated)
 * string; empty (`""`) when there are no active requests.
 *
 * Every branch returns an uncolored inner string; {@link finalizeFooter} is the
 * single exit that strips control chars, width-truncates, and applies the one
 * `pc.dim` wrap. This structure guarantees the footer never exceeds one physical
 * line regardless of concurrency or content — see the hard invariant documented
 * on {@link finalizeFooter}.
 */
export function buildActiveFooter(args: { active: ReadonlyArray<ActiveRequestView>; now: number; columns: number }): string {
  const { active, now, columns } = args
  const count = active.length
  if (count === 0) return ""

  if (count === 1) {
    const entry = active[0]
    const elapsed = formatDuration(now - entry.ctx.startTime)
    const model = entry.ctx.resolvedModel ? ` ${entry.ctx.resolvedModel}` : ""
    const streamInfo = formatStreamInfo({
      bytesIn: entry.streamBytesIn,
      eventsIn: entry.streamEventsIn,
      blockType: entry.streamBlockType,
    })
    return finalizeFooter(`[<-->] ${entry.ctx.method} ${entry.ctx.path}${model} ${elapsed}${streamInfo}`, columns)
  }

  // Multi-request: group by resolved model (unresolved → "(resolving)"), one
  // compact segment per group. Width-driven inclusion replaces a fixed cap —
  // segments are added greedily until the budget (reserving room for the
  // dim `[<-->] ` prefix and a ` | +K more` tail) is exhausted.
  const segments = buildModelGroupSegments(active, now)
  const budget = columns - 1
  const PREFIX = "[<-->] "
  const shown: Array<string> = []
  let usedWidth = PREFIX.length // ASCII prefix — width === length
  for (let i = 0; i < segments.length; i++) {
    const sep = shown.length > 0 ? 3 : 0 // " | "
    const remaining = segments.length - i
    // Reserve space for a " | +K more" tail if any groups will be dropped.
    const moreTail = remaining > 1 ? ` | +${remaining - 1} more`.length : 0
    const segWidth = stringWidth(segments[i])
    if (usedWidth + sep + segWidth + moreTail > budget && shown.length > 0) break
    usedWidth += sep + segWidth
    shown.push(segments[i])
  }
  const overflow = segments.length - shown.length
  if (overflow > 0) shown.push(`+${overflow} more`)
  return finalizeFooter(`${PREFIX}${shown.join(" | ")}`, columns)
}

/**
 * One compact plain-text segment per model group: `<model> ×N ↓<sumBytes>
 * <maxElapsed>`. Groups are sorted by descending count, then by oldest
 * request first. `sumBytes` is only shown when the group has streaming
 * progress; `maxElapsed` is the group's longest-running request.
 */
function buildModelGroupSegments(active: ReadonlyArray<ActiveRequestView>, now: number): Array<string> {
  interface Group {
    model: string
    count: number
    sumBytes: number
    hasBytes: boolean
    oldestStart: number
  }
  const groups = new Map<string, Group>()
  for (const entry of active) {
    const model = entry.ctx.resolvedModel ?? "(resolving)"
    let g = groups.get(model)
    if (!g) {
      g = { model, count: 0, sumBytes: 0, hasBytes: false, oldestStart: entry.ctx.startTime }
      groups.set(model, g)
    }
    g.count += 1
    if (entry.streamBytesIn !== undefined) {
      g.sumBytes += entry.streamBytesIn
      g.hasBytes = true
    }
    if (entry.ctx.startTime < g.oldestStart) g.oldestStart = entry.ctx.startTime
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.oldestStart - b.oldestStart)
    .map((g) => {
      const bytes = g.hasBytes ? ` ↓${formatBytes(g.sumBytes)}` : ""
      const elapsed = formatDuration(now - g.oldestStart)
      return `${g.model} ×${g.count}${bytes} ${elapsed}`
    })
}

/**
 * Single exit for all footer branches. Enforces the **footer ≤ 1 physical
 * line** invariant that the sink's `clearFooterForLog` and `renderFooter`
 * (single-line `CLEAR_LINE`) depend on:
 *  1. strip control chars (`\n`/`\r`/…) so no embedded newline can force a
 *     wrap regardless of model-name / path content;
 *  2. truncate to `columns - 1` display columns (the -1 avoids the
 *     last-column auto-wrap some terminals do);
 *  3. apply the single `pc.dim` wrap (zero-width ANSI, does not affect
 *     display width).
 * `inner` must be plain text — truncation slices on code points.
 */
function finalizeFooter(inner: string, columns: number): string {
  // Strip all C0 control chars (\n, \r, \t, …) — any of them would force a
  // second physical line and break the single-line invariant.
  // eslint-disable-next-line no-control-regex -- intentional C0 range
  const oneLine = inner.replaceAll(/[\x00-\x1f]+/g, " ")
  return pc.dim(truncateToWidth(oneLine, columns - 1))
}
