import type { ReactNode } from "react"

export function LegShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 border border-[var(--surface-border)]">
      <div className="mono bg-[var(--surface-raised-alt)] px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--content-accent)]">{label}</div>
      <div className="p-2">{children}</div>
    </div>
  )
}
