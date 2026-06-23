export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="mono border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="text-[18px] font-bold text-[var(--color-primary)]">{value}</div>
      {sub ?
        <div className="text-[12px] text-[#888]">{sub}</div>
      : null}
    </div>
  )
}
