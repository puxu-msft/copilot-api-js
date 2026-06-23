import { useEntries } from "@/hooks/useEntries"
import {
  //
  formatDuration,
  statusSignal,
} from "@/lib/format"

const SIGNAL_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

export function RequestsListPage() {
  const { data, isLoading, isError } = useEntries(50)
  if (isLoading) return <div className="mono p-2 text-[#888]">loading…</div>
  if (isError) return <div className="mono p-2 text-[var(--color-fail)]">failed to load entries</div>
  const entries = data?.entries ?? []
  return (
    <div className="mono text-[11px]">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[var(--color-muted)]">Requests · {data?.total ?? 0} total</div>
      {entries.map((e) => (
        <div
          key={e.id}
          className="flex gap-3 border-b border-[#222] px-1 py-1"
        >
          <span style={{ color: SIGNAL_COLOR[statusSignal(e.state ?? "")] }}>{e.state ?? "—"}</span>
          <span className="text-[#cdb]">{e.responseModel ?? e.requestModel ?? "—"}</span>
          <span className="text-[#888]">{e.durationMs === undefined ? "" : formatDuration(e.durationMs)}</span>
        </div>
      ))}
    </div>
  )
}
