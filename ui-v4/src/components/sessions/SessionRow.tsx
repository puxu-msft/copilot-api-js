import { useNavigate } from "react-router-dom"

import type { SessionSummary } from "@/types"

import { formatDuration } from "@/lib/format"

export function SessionRow({ s }: { s: SessionSummary }) {
  const navigate = useNavigate()
  const span = s.lastStartedAt - s.firstStartedAt
  return (
    <button
      type="button"
      onClick={() => navigate(`/sessions/${s.sessionId}`)}
      className="mono flex w-full items-center gap-3 border-b border-[#222] px-2 py-1.5 text-left text-[13px] text-[#aaa] hover:bg-[#1a1a1f]"
    >
      <span className="text-[var(--color-primary)]">{s.sessionId.slice(0, 12)}…</span>
      <span>{s.requestCount} req</span>
      <span className="text-[#888]">{s.agentCount} agents</span>
      <span className="text-[#888]">
        ↑{s.inputTokens} ↓{s.outputTokens}
      </span>
      {s.failed > 0 ?
        <span className="text-[var(--color-fail)]">{s.failed} fail</span>
      : null}
      <span className="ml-auto text-[#888]">{formatDuration(span)}</span>
    </button>
  )
}
