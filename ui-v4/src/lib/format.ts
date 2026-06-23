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
