import { useNavigate } from "react-router-dom"

import type { EntrySummary } from "@/types"

import {
  //
  statusSignal,
  type Signal,
} from "@/lib/format"

const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

export function AgentLane({ name, entries }: { name: string; entries: Array<EntrySummary> }) {
  const navigate = useNavigate()
  return (
    <div className="mono flex items-center gap-2 border-b border-[#1e1e24] py-1.5 text-[12px]">
      <span
        className="w-[160px] shrink-0 truncate text-[var(--color-primary)]"
        title={name}
      >
        {name}
      </span>
      <div className="flex flex-wrap gap-1">
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => navigate(`/requests/${e.id}`)}
            title={`${e.state ?? ""} · ${e.id}`}
            className="h-3.5 w-6"
            style={{ background: SIGNAL_COLOR[statusSignal(e.state ?? "")] }}
          />
        ))}
      </div>
    </div>
  )
}
