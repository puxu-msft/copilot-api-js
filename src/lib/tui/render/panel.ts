/**
 * P1 interactive-TUI presentation builders — pure functions that turn the live
 * request set into the exact strings the sticky {@link Region} draws. Three
 * modes, one shared width discipline:
 *
 *  - {@link buildCollapsedLines}: the default one-liner (Region N=1) — the live
 *    footer plus a discoverability hint (`space: expand`);
 *  - {@link buildPanelLines}: the expanded per-request table with a selection
 *    cursor and a scroll window;
 *  - {@link buildDetailLines}: the full context snapshot of a single request,
 *    including per-attempt diagnostics.
 *
 * Purity: no `this`, no wall clock, no I/O. Callers supply the request views,
 * the current `now`, and the (already width-sanitized) `columns`.
 *
 * The load-bearing invariant every branch upholds: **each returned line has a
 * display width ≤ columns-1**. The Region renderer clamps too, but a wider line
 * auto-wraps and corrupts DECSTBM anchoring, so we truncate content *before*
 * wrapping it in zero-width styling (reverse-video / dim) — {@link truncateToWidth}
 * must receive plain text, so styling is always the last step.
 */

import pc from "picocolors"
import stringWidth from "string-width"

import type { AttemptSnapshot } from "~/lib/observability"

import {
  //
  formatBytes,
  formatDuration,
  formatDurationField,
  truncateToWidth,
} from "~/lib/observability/projections/format"

import type { ActiveRequestView } from "./footer"

import { buildActiveFooter } from "./footer"

/**
 * Literal reverse-video (SGR 7 / 27). Deliberately not `pc.inverse`: the panel
 * must show a visible selection cursor even in the non-TTY test harness, where
 * picocolors suppresses all codes. These are zero-width, so a wrapped line's
 * measured width is unchanged.
 */
const REVERSE_ON = "\x1b[7m"
const REVERSE_OFF = "\x1b[27m"

/**
 * The rich per-request view the panel/detail layers consume. `ActiveRequestView`
 * (footer's projection) carries only what a one-line footer reads; the panel's
 * table and the detail snapshot additionally surface accumulated dimensions —
 * feature `tags`, the `thinking` requested→effective pair, and the full
 * per-attempt `attempts[]`. Per richest-data-flow, detail consumes the complete
 * attempt array (strategy / transport / error), never a collapsed count. Task 5
 * accumulates these fields from `request.feature_applied` / `attempt_*` events.
 */
export interface DetailView extends ActiveRequestView {
  /** Applied feature tags (e.g. `thinking`, `beta-stripped`, `via-responses`). */
  tags?: Array<string>
  /**
   * Thinking as a terminal dimension: `requested` is the client's original
   * `thinking.type`; `effective` is the final outbound wire value (last attempt
   * wins). They differ when the pipeline coerced it (e.g. `enabled`→`adaptive`).
   */
  thinking?: { requested?: string; effective: string }
  /** Full per-attempt diagnostics — one entry per `request.attempt_started`. */
  attempts?: Array<AttemptSnapshot>
}

/**
 * Total lines the expanded panel may occupy at once (content + overflow
 * indicator + keybar). A *bounded* height is the whole point: the panel's height
 * drove the blank-line bug — as the in-flight count changed, the panel grew and
 * shrank, forcing {@link Region} to tear down and rebuild its DECSTBM scroll
 * region every time (geometry churn leaves stray blank rows). Capping the height
 * keeps it constant while the list is long, so the region only re-establishes on
 * first-open / resize, not on every request arrival; overflow is reached via the
 * selection cursor (controller scroll) with an on-panel `↑K ↓M more` indicator.
 */
export const MAX_PANEL_ROWS = 3

/**
 * How many request rows the panel's scroll window shows, given the total row
 * budget, the active count, and whether the keybar is shown. The budget is
 * capped at {@link MAX_PANEL_ROWS}; one line is reserved for the keybar
 * (`showHelp`) and one for the overflow indicator (when the list is longer than
 * fits). Always ≥ 1.
 *
 * Depends ONLY on the totals — never on `scrollOffset` — so the controller's
 * `visibleRows`, computed from the same inputs, stays exactly aligned with the
 * window `buildPanelLines` slices, regardless of where the user scrolled. (A
 * scroll-dependent count would feed back: scroll changes the indicator, the
 * indicator changes the window, the window changes the scroll.)
 */
export function panelContentRows(totalRows: number, activeCount: number, showHelp: boolean): number {
  const budget = Math.min(totalRows, MAX_PANEL_ROWS)
  const afterKeybar = Math.max(1, showHelp ? budget - 1 : budget)
  const overflow = activeCount > afterKeybar
  return overflow ? Math.max(1, afterKeybar - 1) : afterKeybar
}

/** ` ↑<reqBytes> ↓<respBytes>` — either side omitted (`-`) when unknown. */
function formatByteFlow(reqBytes: number | undefined, respBytes: number | undefined): string {
  const up = reqBytes === undefined ? "-" : formatBytes(reqBytes)
  const down = respBytes === undefined ? "-" : formatBytes(respBytes)
  return `↑${up} ↓${down}`
}

/**
 * Collapsed mode: the live footer plus a discoverability hint, as a
 * single-element array (Region N=1). The footer is given a reduced width budget
 * so the (zero-truncation) hint always fits within `columns-1`; when the width
 * is too narrow for both, the footer is dropped and the hint alone is truncated.
 */
export function buildCollapsedLines(args: { active: ReadonlyArray<ActiveRequestView>; now: number; columns: number; showHelp: boolean }): Array<string> {
  const { active, now, columns, showHelp } = args
  // Minimal by default (RFC §5 discoverability); richer when help is toggled.
  const hint = showHelp ? " · space: expand · ↑↓: nav · q: quit" : " · space: expand"
  const hintWidth = stringWidth(hint)

  // Reserve the hint's width; the footer fills the remainder. `buildActiveFooter`
  // truncates to (footerBudget - 1), so footer + hint ≤ columns - 1.
  const footerBudget = columns - hintWidth
  if (footerBudget > 1) {
    const footer = buildActiveFooter({ active, now, columns: footerBudget })
    return [footer + pc.dim(hint)]
  }
  // Too narrow for a footer — truncate the (plain) hint alone.
  return [pc.dim(truncateToWidth(hint, columns - 1))]
}

/**
 * Expanded mode: a **fixed-height** table. The total line count is constant —
 * `content (padded) + overflow-indicator? + keybar?` always sums to
 * `min(rows, MAX_PANEL_ROWS)` regardless of the in-flight count — because the
 * indicator absorbs exactly the one content row it costs. Fixed height is
 * load-bearing: a panel that grew/shrank with the request count made the DECSTBM
 * {@link Region} resize its scroll region, which both left churn blank lines AND
 * ate already-printed history lines as the region reclaimed a log row. Short
 * lists are padded with blank rows to hold the height.
 *
 * Content is the scroll window `active.slice(scrollOffset, scrollOffset +
 * contentRows)`; a dim `↑<above> ↓<below> more` indicator summarises hidden
 * entries when the list overflows. The row at `selectedIndex` is reverse-video.
 * Every line is truncated to `columns-1` before styling.
 */
export function buildPanelLines(args: {
  active: ReadonlyArray<DetailView>
  now: number
  columns: number
  selectedIndex: number
  scrollOffset: number
  rows: number
  showHelp: boolean
}): Array<string> {
  const { active, now, columns, selectedIndex, scrollOffset, rows, showHelp } = args
  const budget = columns - 1
  const contentRows = panelContentRows(rows, active.length, showHelp)
  const window = active.slice(scrollOffset, scrollOffset + contentRows)

  const lines = window.map((view, i) => {
    const globalIndex = scrollOffset + i
    const row = truncateToWidth(formatPanelRow(view, now), budget)
    return globalIndex === selectedIndex ? `${REVERSE_ON}${row}${REVERSE_OFF}` : row
  })

  // Pad with blank rows so the panel height stays constant even when the list is
  // shorter than the window — this is what keeps the DECSTBM region from
  // resizing (and thus eating history lines) as requests come and go.
  while (lines.length < contentRows) lines.push("")

  // Bidirectional overflow indicator — only when the list is longer than the
  // content window (`panelContentRows` reserved a row for it in that case).
  const above = scrollOffset
  const below = Math.max(0, active.length - (scrollOffset + contentRows))
  if (above > 0 || below > 0) {
    lines.push(pc.dim(truncateToWidth(`↑${above} ↓${below} more`, budget)))
  }

  if (showHelp) {
    lines.push(pc.dim(truncateToWidth("↑↓ nav · enter detail · esc back · q quit", budget)))
  }
  return lines
}

/** One plain-text table row: `<req_id> <model> <method> <path> <elapsed> <bytes> <events>ev <tags>`. */
function formatPanelRow(view: DetailView, now: number): string {
  const { ctx } = view
  // Full request id, not a prefix slice: real ids look like `req_<ts>_<seq>`
  // where the DISTINGUISHING part is the trailing `_<seq>` — a leading slice
  // would show only the shared `req_<ts>` prefix. The id sits at the row head,
  // so `truncateToWidth` (which trims the tail) never eats it.
  const id = ctx.id
  const model = ctx.resolvedModel ?? "(resolving)"
  // 有重试时 elapsed 展开为 last/total(N)（顶层标量由 Task 4 轻量 snapshot 保证）；纯文本不着色。
  const pRetries = (ctx.attemptCount ?? 1) - 1
  const pLastMs = ctx.currentAttemptStartedAt !== undefined ? now - ctx.currentAttemptStartedAt : undefined
  const elapsed = formatDurationField({ lastMs: pLastMs, totalMs: now - ctx.startTime, retries: pRetries })
  const bytes = formatByteFlow(ctx.requestBodySize, view.streamBytesIn)
  const events = `${view.streamEventsIn ?? 0}ev`
  const tags = view.tags && view.tags.length > 0 ? ` [${view.tags.join(",")}]` : ""
  return `${id} ${model} ${ctx.method} ${ctx.path} ${elapsed} ${bytes} ${events}${tags}`
}

/**
 * Detail mode: the full context snapshot of one request as a truncated
 * multi-line block — identity, resolved routing, byte/event totals, applied
 * tags, the thinking requested→effective pair, and complete per-attempt
 * diagnostics (strategy / transport / error). Each line is independently
 * truncated to `columns-1`.
 */
export function buildDetailLines(args: { entry: DetailView; now: number; columns: number }): Array<string> {
  const { entry, now, columns } = args
  const budget = columns - 1
  const { ctx } = entry

  // 与 formatPanelRow 一致：有重试时 elapsed 展开为 last/total(N)，纯文本不着色。
  const pRetries = (ctx.attemptCount ?? 1) - 1
  const pLastMs = ctx.currentAttemptStartedAt !== undefined ? now - ctx.currentAttemptStartedAt : undefined

  const raw: Array<string> = [
    `req_id: ${ctx.id}`,
    `${ctx.method} ${ctx.path}`,
    `model: ${ctx.clientModel ?? "?"} → ${ctx.resolvedModel ?? "(resolving)"}`,
    ...(ctx.multiplier === undefined ? [] : [`multiplier: ${ctx.multiplier}x`]),
    `state: ${ctx.state}`,
    `elapsed: ${formatDurationField({ lastMs: pLastMs, totalMs: now - ctx.startTime, retries: pRetries })}`,
    `queueWait: ${formatDuration(ctx.queueWaitMs)}`,
    `bytes: ${formatByteFlow(ctx.requestBodySize, entry.streamBytesIn)}`,
    `events: ${entry.streamEventsIn ?? 0}`,
    ...(entry.streamBlockType === undefined ? [] : [`block: ${entry.streamBlockType}`]),
    ...(entry.tags && entry.tags.length > 0 ? [`tags: ${entry.tags.join(", ")}`] : []),
    ...(entry.thinking ? [`thinking: ${entry.thinking.requested ?? "(unset)"} (requested) → ${entry.thinking.effective} (effective)`] : []),
    ...(entry.attempts && entry.attempts.length > 0 ?
      [`attempts: ${entry.attempts.length}`, ...entry.attempts.map((attempt) => `  ${formatAttempt(attempt)}`)]
    : []),
  ]

  return raw.map((line) => truncateToWidth(line, budget))
}

/** One attempt's plain diagnostic line: index, strategy, transport, and error if any. */
function formatAttempt(attempt: AttemptSnapshot): string {
  const parts: Array<string> = [`#${attempt.attemptIndex}`]
  if (attempt.strategy) parts.push(attempt.strategy)
  if (attempt.transport) parts.push(`[${attempt.transport}]`)
  if (attempt.error) parts.push(`error ${attempt.error.status} ${attempt.error.type}: ${attempt.error.message}`)
  return parts.join(" ")
}
