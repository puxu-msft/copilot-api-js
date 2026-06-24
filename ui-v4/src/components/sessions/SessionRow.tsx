import { useNavigate } from "react-router-dom"

import type { SessionSummary } from "@/types"

import {
  //
  formatDuration,
  formatNumber,
} from "@/lib/format"

/** Session 行 —— 左侧绿/红状态方块 + 元数据(紧凑) + 最后一条消息摘要(占剩余宽度) + 右侧时长。 */
export function SessionRow({ s }: { s: SessionSummary }) {
  const navigate = useNavigate()
  const span = s.lastStartedAt - s.firstStartedAt
  const hasFailures = s.failed > 0
  return (
    <button
      type="button"
      onClick={() => navigate(`/sessions/${s.sessionId}`)}
      className="mono flex w-full items-center gap-3 border-b border-[#222] px-2 py-1.5 text-left text-[13px] text-[#aaa] hover:bg-[#1a1a1f]"
    >
      <span
        className="h-2.5 w-2.5 shrink-0"
        style={{ background: hasFailures ? "var(--color-fail)" : "var(--color-ok)" }}
        title={hasFailures ? `${s.failed} failed` : "all ok"}
      />
      <span className="shrink-0 text-[var(--color-primary)]">{s.sessionId.slice(0, 12)}…</span>
      <span className="shrink-0">{s.requestCount} req</span>
      <span className="shrink-0 text-[#888]">{s.agentCount} agents</span>
      <span className="shrink-0 text-[#888]">
        ↑{formatNumber(s.inputTokens)} ↓{formatNumber(s.outputTokens)}
      </span>
      {hasFailures ?
        <span className="shrink-0 text-[var(--color-fail)]">{s.failed} fail</span>
      : null}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a8a7a]">{s.preview || "—"}</span>
      <span className="shrink-0 text-[#888]">{formatDuration(span)}</span>
    </button>
  )
}
