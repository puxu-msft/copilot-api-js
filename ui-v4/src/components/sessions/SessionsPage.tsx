import { SessionRow } from "@/components/sessions/SessionRow"
import { useSessions } from "@/hooks/useSessions"

export function SessionsPage() {
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
