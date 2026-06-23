import { useState } from "react"

import { useModels } from "@/hooks/useModels"

export function ModelsPage() {
  const { data, isLoading } = useModels()
  const [raw, setRaw] = useState(false)
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const models = data?.data ?? []
  return (
    <div className="mono p-2 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Models · {models.length}</div>
        <button
          type="button"
          className="ml-auto text-[12px] text-[var(--color-primary)]"
          onClick={() => setRaw((v) => !v)}
        >
          {raw ? "table" : "raw JSON"}
        </button>
      </div>
      {raw ?
        <pre className="whitespace-pre-wrap break-all text-[12px] text-[#aaa]">{JSON.stringify(models, null, 2)}</pre>
      : <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] uppercase text-[var(--color-muted)]">
              <th className="px-2 py-1 text-left">id</th>
              <th className="px-2 py-1 text-left">name</th>
              <th className="px-2 py-1 text-left">vendor</th>
              <th className="px-2 py-1 text-left">version</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => (
              <tr
                key={m.id ?? i}
                className="border-b border-[#1e1e24]"
              >
                <td className="px-2 py-1 text-[var(--color-primary)]">{m.id ?? "—"}</td>
                <td className="px-2 py-1 text-[#cdb]">{m.name ?? "—"}</td>
                <td className="px-2 py-1 text-[#aaa]">{m.vendor ?? "—"}</td>
                <td className="px-2 py-1 text-[#888]">{m.version ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    </div>
  )
}
