import { useParams } from "react-router-dom"

import { useEntry } from "@/hooks/useEntry"
import { formatDuration } from "@/lib/format"

/** 详情占位 —— 按 URL :id 独立 fetch(spec §4.1)。完整 C 布局见 Plan 03。 */
export function DetailPlaceholder() {
  const { id } = useParams()
  const { data, isLoading, isError, error } = useEntry(id)

  if (!id) return <div className="mono p-4 text-[#666]">← 选一条请求看详情</div>
  if (isLoading) return <div className="mono p-4 text-[#888]">loading {id}…</div>
  if (isError) {
    const msg = error instanceof Error ? error.message : "load failed"
    return <div className="mono p-4 text-[var(--color-fail)]">详情加载失败:{msg}</div>
  }
  if (!data) return null

  return (
    <div className="mono flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[#222] bg-[#1c1c22] px-3 py-1.5 text-[10px] text-[#cdb]">
        <span className="text-[var(--color-primary)]">{data.endpoint}</span>
        {data.durationMs === undefined ? "" : ` · ${formatDuration(data.durationMs)}`}
        {" · "}
        <span className="text-[#888]">{id}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-[var(--color-muted)]">raw entry (Plan 03 将替为 C 布局)</div>
        <pre className="whitespace-pre-wrap break-all text-[10px] text-[#aaa]">{JSON.stringify(data, null, 2)}</pre>
      </div>
    </div>
  )
}
