// 请求行的纯域逻辑(从老 UI ui/src/utils/activity-helpers.ts 逐字移植,仅调整 import)。
// 让诊断在 LIST 行内完成,无需展开详情页(spec §4.2 富行)。
import type { EntrySummary } from "@/types"

import { formatNumber } from "@/lib/format"

/**
 * Display-only state label for a row. Heuristic (falls back to `responseSuccess`
 * then `"pending"`); **do NOT reuse for Live/History routing** — that gate is
 * `isTerminalSummary` below, which mirrors the backend exactly.
 */
export function requestState(entry: EntrySummary): string {
  if (entry.state) return entry.state
  if (entry.responseSuccess === false) return "failed"
  if (entry.responseSuccess) return "completed"
  return "pending"
}

/** Non-terminal lifecycle states — these requests belong to the Live lane, not History. */
const NON_TERMINAL_STATES = new Set<EntrySummary["state"]>(["pending", "executing", "streaming"])

/**
 * Whether a request summary is terminal (belongs in the History list) vs an
 * active in-flight one (belongs in the Live lane). Mirrors the backend
 * `isInFlightSummary` (queries.ts): `active:true` or a non-terminal `state`
 * means in-flight. Used to gate WS `entry_added`/`entry_updated` events so a
 * request only enters the History flow once it actually reaches a terminal
 * state (completed/failed/aborted/interrupted).
 */
export function isTerminalSummary(entry: EntrySummary): boolean {
  return entry.active !== true && !NON_TERMINAL_STATES.has(entry.state)
}

export function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

export function endpointLabel(entry: EntrySummary): string {
  if (entry.rawPath) return entry.rawPath
  return entry.endpoint
    .replace(/^\/v\d+\//, "")
    .replaceAll("/", " ")
    .replaceAll("-", " ")
}

export function tokenIn(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.input_tokens)
}

export function tokenOut(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.output_tokens)
}

/** Cache-read tokens (prompt cache hit) for the list; "-" when none. */
export function tokenCacheRead(entry: EntrySummary): string {
  const n = entry.usage?.cache_read_input_tokens
  return n ? formatNumber(n) : "-"
}

export function truncPreview(entry: EntrySummary): string {
  const text = entry.previewText || entry.responseError || ""
  if (text.length <= 120) return text
  return text.slice(0, 117) + "..."
}

/** 响应内容预览的列表截断(镜像 truncPreview；后端已算好工具优先格式)。 */
export function truncResponsePreview(entry: EntrySummary): string {
  const text = entry.responsePreviewText || ""
  if (text.length <= 120) return text
  return text.slice(0, 117) + "..."
}

/**
 * Structured failure/abort attribution for non-completed rows, so diagnosis can
 * happen in the LIST without opening the detail page. Examples:
 *   "aborted @stream"  ·  "failed · auto-truncate ×3 · 413 too large"
 *   "interrupted (pid 1234)"  ·  "executing · attempt 2"
 * For completed rows returns "" (caller shows the normal preview instead).
 */
export function failureSummary(entry: EntrySummary): string {
  const state = requestState(entry)
  if (state === "completed") return ""
  const parts: Array<string> = [state]
  if (entry.currentStrategy) parts.push(entry.currentStrategy)
  if (entry.attemptCount && entry.attemptCount > 1) parts.push(`×${entry.attemptCount}`)
  if (state === "interrupted" && entry.pid) parts.push(`pid ${entry.pid}`)
  if (entry.responseError) parts.push(entry.responseError.slice(0, 80))
  return parts.join(" · ")
}

/** Heuristic anomaly flags surfaced in the list (slow / cache-miss). */
export function rowAnomaly(entry: EntrySummary): { slow: boolean; cacheMiss: boolean } {
  const slow = (entry.durationMs ?? 0) > 60_000
  const cacheMiss = requestState(entry) === "completed" && (entry.usage?.input_tokens ?? 0) > 20_000 && !entry.usage?.cache_read_input_tokens
  return { slow, cacheMiss }
}
