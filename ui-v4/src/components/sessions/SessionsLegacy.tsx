import { SessionRow } from "@/components/sessions/SessionRow"
import { useSessions } from "@/hooks/useSessions"

/**
 * fork B · Sessions 页元素(legacy,Terminal Amber,P5 前逐字冻结)。
 * 原 `SessionsPage` body 逐字搬来,Z1 收尾才删。共用 B 内容体 `SessionRow`(C3 中性化)。
 */
export function SessionsLegacy() {
  const { data, isLoading } = useSessions()
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const sessions = data?.sessions ?? []
  if (sessions.length === 0) return <div className="mono p-4 text-[var(--color-muted)]">无 session</div>
  return (
    <div className="mono p-2">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Sessions · {sessions.length}</div>
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          s={s}
        />
      ))}
    </div>
  )
}
