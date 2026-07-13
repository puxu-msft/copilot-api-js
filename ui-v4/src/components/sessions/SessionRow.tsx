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
      className="mono flex w-full items-center gap-3 border-b border-[var(--surface-border-row)] px-2 py-1.5 text-left text-[13px] text-[var(--content-secondary)] hover:bg-[var(--surface-raised-alt)]"
    >
      <span
        className="h-2.5 w-2.5 shrink-0"
        style={{ background: hasFailures ? "var(--signal-fail)" : "var(--signal-ok)" }}
        title={`${s.completed} ok / ${s.failed} fail`}
      />
      <span
        className="shrink-0 text-[var(--content-dim)]"
        title={`${formatTime(s.firstStartedAt)} → ${formatTime(s.lastStartedAt)}`}
      >
        {formatTime(s.firstStartedAt)}→{formatTime(s.lastStartedAt)}
      </span>
      <span className="shrink-0 text-[var(--content-dim)]">{formatDuration(span)}</span>
      <span
        className="shrink-0 text-[var(--content-accent)]"
        title={s.sessionId}
      >
        {s.sessionId.slice(0, 12)}…
      </span>
      <span className="shrink-0 text-[var(--content-dim)]">{agentLabel}</span>
      <span className="shrink-0">{s.requestCount} req</span>
      <span className="shrink-0 text-[var(--content-dim)]">
        ↑{formatNumber(s.inputTokens)} ↓{formatNumber(s.outputTokens)}
      </span>
      <span className="shrink-0">
        <span style={{ color: "var(--signal-ok)" }}>✓{s.completed}</span>{" "}
        <span style={{ color: hasFailures ? "var(--signal-fail)" : "var(--content-disabled)" }}>✗{s.failed}</span>
        {s.aborted > 0 ?
          <span className="text-[var(--signal-warn)]"> ⊘{s.aborted}</span>
        : null}
      </span>
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--content-preview)]"
        title={[s.firstPreview, s.preview].filter(Boolean).join(" ⟶ ") || undefined}
      >
        {s.firstPreview || "—"} <span className="text-[var(--content-disabled)]">⟶</span> {s.preview || "—"}
      </span>
    </button>
  )
}
