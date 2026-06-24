import { useNavigate } from "react-router-dom"

import type { EntrySummary } from "@/types"

import { RequestRow } from "@/components/requests/RequestRow"
import { formatNumber } from "@/lib/format"

/** Lane 聚合摘要:请求数 + ↑in↓out token 汇总 + failed 计数(从 entries 派生)。 */
function laneSummary(entries: Array<EntrySummary>): { count: number; input: number; output: number; failed: number } {
  let input = 0
  let output = 0
  let failed = 0
  for (const e of entries) {
    input += e.usage?.input_tokens ?? 0
    output += e.usage?.output_tokens ?? 0
    if (e.state === "failed") failed += 1
  }
  return { count: entries.length, input, output, failed }
}

/**
 * 单个 agent 的分段视图(spec §5 + 用户反馈):一个 **表标题**(agent 名 + 紧凑摘要)
 * 后跟该 agent 的请求 **列表**(复用 RequestRow 富行),而非连续的彩色块。
 * 标题左侧 amber accent + hairline 下划线,工业 Terminal Amber 密行风格。
 */
export function AgentLane({ name, entries }: { name: string; entries: Array<EntrySummary> }) {
  const navigate = useNavigate()
  const { count, input, output, failed } = laneSummary(entries)
  return (
    <div className="mono">
      <div className="flex items-center gap-2 border-b border-[#1e1e24] border-l-2 border-l-[var(--color-primary)] bg-[#1a160e] py-1 pl-2 text-[12px]">
        <span
          className="shrink-0 truncate font-bold text-[var(--color-primary)]"
          title={name}
        >
          {name}
        </span>
        <span className="text-[var(--color-muted)]">
          {count} req · ↑{formatNumber(input)} ↓{formatNumber(output)}
        </span>
        {failed > 0 ?
          <span className="text-[var(--color-fail)]">{failed} failed</span>
        : null}
      </div>
      <div>
        {entries.map((e) => (
          <RequestRow
            key={e.id}
            entry={e}
            onClick={() => navigate(`/requests/${e.id}`)}
          />
        ))}
      </div>
    </div>
  )
}
