import type { LiveEntry } from "@/stores/live-store"

export interface LiveGroupData {
  key: string
  model: string
  count: number
  streaming: number
  oldestElapsedMs: number
  rows: Array<LiveEntry>
}
export interface LiveSummary {
  count: number
  streaming: number
  retrying: number
  oldestElapsedMs: number
  groups: Array<LiveGroupData>
}

/** 分组键:resolvedModel 优先,pending 未 resolve 时回退 client model,再回退占位。 */
export function groupKey(row: LiveEntry): string {
  return row.resolvedModel ?? row.model ?? "resolving…"
}

function isStreaming(row: LiveEntry): boolean {
  return row.state === "streaming"
}
function isRetrying(row: LiveEntry): boolean {
  return row.retry?.willRetry === true
}

/** 纯聚合:总计 + 按模型分组(组/组内均 oldest-first)。elapsed 由 nowMs - startTime 现算。 */
export function summarizeLive(rows: Array<LiveEntry>, nowMs: number): LiveSummary {
  const byKey = new Map<string, Array<LiveEntry>>()
  for (const r of rows) {
    const k = groupKey(r)
    const bucket = byKey.get(k)
    if (bucket) bucket.push(r)
    else byKey.set(k, [r])
  }
  const groups: Array<LiveGroupData> = [...byKey.entries()].map(([key, gRows]) => {
    const sorted = [...gRows].sort((a, b) => a.startTime - b.startTime)
    // bucket 仅在推入首元素时创建,故必非空;sorted[0] 类型即 LiveEntry。
    const oldest = sorted[0]
    return {
      key,
      model: key,
      count: sorted.length,
      streaming: sorted.filter((r) => isStreaming(r)).length,
      oldestElapsedMs: nowMs - oldest.startTime,
      rows: sorted,
    }
  })
  groups.sort((a, b) => b.oldestElapsedMs - a.oldestElapsedMs) // 组按最旧 elapsed 降序(= startTime 升序)
  return {
    count: rows.length,
    streaming: rows.filter((r) => isStreaming(r)).length,
    retrying: rows.filter((r) => isRetrying(r)).length,
    oldestElapsedMs: rows.length === 0 ? 0 : Math.max(...rows.map((r) => nowMs - r.startTime)),
    groups,
  }
}
