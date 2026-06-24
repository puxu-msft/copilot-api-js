export type Signal = "ok" | "fail" | "warn" | "live" | "muted"

/** 把生命周期/结果状态映射为工业信号色类(spec §8 green/red/amber)。 */
export function statusSignal(status: string): Signal {
  switch (status) {
    case "completed": {
      return "ok"
    }
    case "failed":
    case "aborted":
    case "interrupted": {
      return "fail"
    }
    case "pending":
    case "executing":
    case "streaming": {
      return "live"
    }
    case "rate_limited": {
      return "warn"
    }
    default: {
      return "muted"
    }
  }
}

/** 毫秒→紧凑人类可读(0ms / 900ms / 1.2s / 1m5s)。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** 毫秒→始终以秒计的 elapsed,带 `+` 前缀(`+1.2s` / `+123.4s`,绝不折成分钟)。用于请求行紧贴起始时间的耗时单元格。 */
export function formatElapsed(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`
}

/** epoch ms → HH:MM:SS (local). */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

/** Compact count: 1234→"1.2K", 1.2M→"1.2M", undefined/null→"-". */
export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return "-"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toString()
}

/**
 * Compact byte size (mirrors backend `src/lib/observability/projections/format.ts`):
 * 0→"0B", 900→"900B", 1536→"1.5KB", 2.4MB→"2.4MB". undefined→"".
 */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ""
  if (n < 1024) return `${n}B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1_048_576).toFixed(1)}MB`
}
