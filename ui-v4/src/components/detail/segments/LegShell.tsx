import type { ReactNode } from "react"

export function LegShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 border border-[var(--color-border)]">
      <div className="mono bg-[#1a1a1f] px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--color-primary)]">{label}</div>
      <div className="p-2">{children}</div>
    </div>
  )
}
