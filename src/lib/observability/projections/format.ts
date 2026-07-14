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

/**
 * Severity color for a request's wall-clock duration: fast requests stay white,
 * escalating as latency grows (a slow request is worth noticing). Shares the
 * yellow → red → bold-red escalation with {@link cacheHitColor} for a unified
 * palette; no `dim` (which the terminal renders as grey) and no magenta (which
 * clashes with the model-name color in the log line).
 *   ≤ 20s → white   ≤ 60s → yellow   ≤ 180s → red   > 180s → bold red
 */
export function durationColor(ms: number): (s: string) => string {
  if (ms <= 20_000) return pc.white
  if (ms <= 60_000) return pc.yellow
  if (ms <= 180_000) return pc.red
  return (s) => pc.bold(pc.red(s))
}

/**
 * 判定 `lastMs`（最后一次 attempt 自身耗时）是否可用于 last/total 展示。
 * 无效：undefined / 非正 / 超过整请求墙钟（脏数据或未定稿的 0 初值）。
 */
function isValidLastMs(lastMs: number | undefined, totalMs: number): lastMs is number {
  return lastMs !== undefined && lastMs > 0 && lastMs <= totalMs
}

/**
 * 重试时长字段：无重试时与 {@link formatDuration} 逐字节一致（`total` 单值）；
 * 有重试时展开为 `last/total(N)`；`lastMs` 无效时兜底 `total(N)`，绝不抛。
 * 纯函数、不含颜色——着色由调用方按 {@link resolveDurationColorMs} 决定。
 */
export function formatDurationField(args: { lastMs: number | undefined; totalMs: number; retries: number }): string {
  const { lastMs, totalMs, retries } = args
  if (retries <= 0) return formatDuration(totalMs)
  if (isValidLastMs(lastMs, totalMs)) return `${formatDuration(lastMs)}/${formatDuration(totalMs)}(${retries})`
  return `${formatDuration(totalMs)}(${retries})`
}

/**
 * 着色驱动值：整个 duration 字段按「实际显示的头部值」的 severity 着色。
 * 有重试且 lastMs 有效 → 按 last（贴合「这次尝试多慢」）；否则按 total（N=0 零回归）。
 */
export function resolveDurationColorMs(args: { lastMs: number | undefined; totalMs: number; retries: number }): number {
  const { lastMs, totalMs, retries } = args
  return retries >= 1 && isValidLastMs(lastMs, totalMs) ? lastMs : totalMs
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
 * Token-count column: `↑<input>+<cacheRead>+<cacheCreation> ↻<hit%>+<new%> ↓<output>`.
 * Cache breakdowns are dim/cyan to deemphasize relative to fresh tokens; the
 * woven-in prompt-cache rate marker ({@link formatCacheRate}) sits between the
 * input group and `↓output` (cache is an input-side property) and is suppressed
 * when there is no cache activity.
 */
export function formatTokens(input?: number, output?: number, cacheRead?: number, cacheCreation?: number): string {
  if (input === undefined && output === undefined) return "-"
  let result = `↑${formatNumber(input ?? 0)}`
  if (cacheRead) result += pc.dim(`+${formatNumber(cacheRead)}`)
  if (cacheCreation) result += pc.cyan(`+${formatNumber(cacheCreation)}`)
  const rate = formatCacheRate(input, cacheRead, cacheCreation)
  if (rate) result += ` ${rate}`
  // ↓output is rendered only when measured: `↓0` means "0 output tokens", while
  // OMITTING it means "output not applicable" — e.g. count_tokens, which counts
  // input only and never produces a completion, so a constant `↓0` is noise.
  if (output !== undefined) result += ` ↓${formatNumber(output)}`
  return result
}

/**
 * Category color for a response's terminal stop_reason, rendered as the
 * `⇥<reason>` token on completion lines. The stored value is heterogeneous
 * across upstream formats — Anthropic `stop_reason` (end_turn / tool_use /
 * max_tokens / stop_sequence / refusal / pause_turn), OpenAI chat
 * `finish_reason` (stop / length / tool_calls / function_call / content_filter),
 * and the Responses `status` (completed / incomplete / failed) — so
 * categorization is a normalized lowercase match with a dim fallback that still
 * shows any unknown value verbatim:
 *   normal completion (end_turn / stop / stop_sequence / completed) → cyan
 *   agentic continuation (tool_use / tool_calls / function_call / pause_turn) → white
 *   truncation (max_tokens / length / incomplete) → yellow
 *   problematic (refusal / content_filter / failed / error) → red
 *   unknown → dim
 */
export function stopReasonColor(reason: string): (s: string) => string {
  switch (reason.toLowerCase()) {
    case "tool_use":
    case "tool_calls":
    case "function_call":
    case "pause_turn": {
      return pc.white
    }
    case "max_tokens":
    case "length":
    case "incomplete": {
      return pc.yellow
    }
    case "refusal":
    case "content_filter":
    case "failed":
    case "error": {
      return pc.red
    }
    case "end_turn":
    case "stop":
    case "stop_sequence":
    case "completed": {
      return pc.cyan
    }
    default: {
      // Any unknown / unmapped value — still shown raw.
      return pc.dim
    }
  }
}

/**
 * Severity color for the cache-hit percentage: a LOW hit rate means the cache
 * did not pay off (expensive fresh tokens), so it is emphasized progressively;
 * a healthy rate stays dim. `+new%` (cache written this request) is neutral.
 *   ≥ 80% → dim (healthy)   ≥ 40% → yellow (watch)
 *   ≥ 20% → red (poor)      < 20% → bold red (severe)
 *
 * Exported so tests can assert the returned color function by reference (the
 * only env-independent check — under `pc.isColorSupported === false` every
 * color collapses to identity, so comparing colored strings proves nothing).
 */
export function cacheHitColor(pct: number): (s: string) => string {
  if (pct >= 80) return pc.dim
  if (pct >= 40) return pc.yellow
  if (pct >= 20) return pc.red
  return (s) => pc.bold(pc.red(s))
}

/**
 * Prompt-cache rate marker: `↻<hit%>+<new%>` where
 *   hit% = cacheRead / (input + cacheRead + cacheCreation)   — severity-colored
 *   new% = cacheCreation / (input + cacheRead + cacheCreation) — cyan (written this request)
 *
 * The denominator is total billed input; `input` here is the NET fresh count,
 * disjoint from the cache fields (see request/usage-normalize.ts), so the three
 * sum to total input. `hit%` is colored by {@link cacheHitColor} (dim when
 * healthy, escalating to bold red as it drops); `new%` is cyan like the cache-
 * creation token segment. Returns `""` when there is no cache activity (both
 * cache fields 0/undefined). The `+new%` segment is only appended when
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
  let result = cacheHitColor(hitPct)(`↻${hitPct}%`)
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
