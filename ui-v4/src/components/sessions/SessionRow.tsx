import { useNavigate } from "react-router-dom"

import type { SessionSummary } from "@/types"

import {
  //
  formatDuration,
  formatNumber,
  formatTime,
} from "@/lib/format"

/** Session 行 —— 状态块 + 起止时刻 + 用时 + id + main+N + req/token + 完成失败数 + 首末 user 消息。 */
export function SessionRow({ s }: { s: SessionSummary }) {
  const navigate = useNavigate()
  const span = s.lastStartedAt - s.firstStartedAt
  const hasFailures = s.failed > 0
  // main 请求 agent_id 为 NULL → COUNT(DISTINCT) 不计，故 agentCount 是 subagent 数；纯 main 显 "main"，有 subagent 显 "main+N"。
  const agentLabel = s.agentCount > 0 ? `main+${s.agentCount}` : "main"
  return (
    <button
      type="button"
      onClick={() => navigate(`/sessions/${s.sessionId}`)}
      className="mono flex w-full items-center gap-3 border-b border-[#222] px-2 py-1.5 text-left text-[13px] text-[#aaa] hover:bg-[#1a1a1f]"
    >
      <span
        className="h-2.5 w-2.5 shrink-0"
        style={{ background: hasFailures ? "var(--color-fail)" : "var(--color-ok)" }}
        title={`${s.completed} ok / ${s.failed} fail`}
      />
      <span
        className="shrink-0 text-[#888]"
        title={`${formatTime(s.firstStartedAt)} → ${formatTime(s.lastStartedAt)}`}
      >
        {formatTime(s.firstStartedAt)}→{formatTime(s.lastStartedAt)}
      </span>
      <span className="shrink-0 text-[#888]">{formatDuration(span)}</span>
      <span
        className="shrink-0 text-[var(--color-primary)]"
        title={s.sessionId}
      >
        {s.sessionId.slice(0, 12)}…
      </span>
      <span className="shrink-0 text-[#888]">{agentLabel}</span>
      <span className="shrink-0">{s.requestCount} req</span>
      <span className="shrink-0 text-[#888]">
        ↑{formatNumber(s.inputTokens)} ↓{formatNumber(s.outputTokens)}
      </span>
      <span className="shrink-0">
        <span style={{ color: "var(--color-ok)" }}>✓{s.completed}</span> <span style={{ color: hasFailures ? "var(--color-fail)" : "#555" }}>✗{s.failed}</span>
        {s.aborted > 0 ?
          <span className="text-[var(--color-warn)]"> ⊘{s.aborted}</span>
        : null}
      </span>
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a8a7a]"
        title={[s.firstPreview, s.preview].filter(Boolean).join(" ⟶ ") || undefined}
      >
        {s.firstPreview || "—"} <span className="text-[#555]">⟶</span> {s.preview || "—"}
      </span>
    </button>
  )
}
