import {
  //
  finalUpstreamRequest,
  finalUpstreamResponse,
} from "~backend/lib/history/entry-view"

import type { HistoryEntry } from "@/types"

export function HeadersSegment({ entry }: { entry: HistoryEntry }) {
  // Per-leg headers: new legs (client/upstream request+response); legacy `httpHeaders.*` removed in P4c.
  const legs: Array<[label: string, headers: Record<string, string> | undefined]> = [
    ["Client → Proxy", entry.clientRequest?.headers],
    ["Proxy → Upstream", finalUpstreamRequest(entry)?.headers],
    ["Upstream → Proxy", finalUpstreamResponse(entry)?.headers],
    ["Proxy → Client", entry.clientResponse?.headers],
  ]
  if (!legs.some(([, h]) => h)) return <div className="mono p-2 text-[13px] text-[var(--content-muted)]">无 headers</div>
  return (
    <div className="flex flex-col gap-2">
      {legs.map(([label, h]) => {
        if (!h) return null
        return (
          <div
            key={label}
            className="border border-[var(--surface-border)]"
          >
            <div className="mono bg-[var(--surface-raised-alt)] px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--content-accent)]">{label}</div>
            <table className="mono w-full text-[13px]">
              <tbody>
                {Object.entries(h).map(([k, v]) => (
                  <tr
                    key={k}
                    className="border-b border-[var(--surface-border-subtle)]"
                  >
                    <td className="px-2 py-0.5 align-top text-[var(--content-muted)]">{k}</td>
                    <td className="break-all px-2 py-0.5 text-[var(--content-secondary)]">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
