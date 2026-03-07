/** Pure formatting functions for TUI display */

import pc from "picocolors"

import type { TuiLogEntry } from "./types"

export function formatTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

/** Format streaming metrics for footer display: ↓12.3KB 42ev [thinking] */
export function formatStreamInfo(req: TuiLogEntry): string {
  if (req.streamBytesIn === undefined) return ""
  const bytes = formatBytes(req.streamBytesIn)
  const events = req.streamEventsIn ?? 0
  const blockType = req.streamBlockType ? ` [${req.streamBlockType}]` : ""
  return ` ↓${bytes} ${events}ev${blockType}`
}

/** Format token counts with colors: dim for cache read, cyan for cache creation */
export function formatTokens(input?: number, output?: number, cacheRead?: number, cacheCreation?: number): string {
  if (input === undefined && output === undefined) return "-"
  let result = `↑${formatNumber(input ?? 0)}`
  if (cacheRead) result += pc.dim(`+${formatNumber(cacheRead)}`)
  if (cacheCreation) result += pc.cyan(`+${formatNumber(cacheCreation)}`)
  result += ` ↓${formatNumber(output ?? 0)}`
  return result
}
