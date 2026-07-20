export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="mono border border-[var(--surface-border)] bg-[var(--surface-raised)] p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--content-muted)]">{label}</div>
      <div className="text-[18px] font-bold text-[var(--content-accent)]">{value}</div>
      {sub ?
        <div className="text-[12px] text-[var(--content-dim)]">{sub}</div>
      : null}
    </div>
  )
}
