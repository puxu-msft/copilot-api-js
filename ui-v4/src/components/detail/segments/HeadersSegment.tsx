import type { HistoryEntry } from "@/types"

const LEGS = [
  ["inboundRequest", "Client → Proxy"],
  ["outboundRequest", "Proxy → Upstream"],
  ["outboundResponse", "Upstream → Proxy"],
  ["inboundResponse", "Proxy → Client"],
] as const

export function HeadersSegment({ entry }: { entry: HistoryEntry }) {
  const headers = entry.httpHeaders
  if (!headers) return <div className="mono p-2 text-[10px] text-[var(--color-muted)]">无 headers</div>
  return (
    <div className="flex flex-col gap-2">
      {LEGS.map(([key, label]) => {
        const h = headers[key]
        if (!h) return null
        return (
          <div
            key={key}
            className="border border-[var(--color-border)]"
          >
            <div className="mono bg-[#1a1a1f] px-2 py-1 text-[8px] uppercase tracking-wider text-[var(--color-primary)]">{label}</div>
            <table className="mono w-full text-[10px]">
              <tbody>
                {Object.entries(h).map(([k, v]) => (
                  <tr
                    key={k}
                    className="border-b border-[#1e1e24]"
                  >
                    <td className="px-2 py-0.5 align-top text-[var(--color-muted)]">{k}</td>
                    <td className="break-all px-2 py-0.5 text-[#aaa]">{v}</td>
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
