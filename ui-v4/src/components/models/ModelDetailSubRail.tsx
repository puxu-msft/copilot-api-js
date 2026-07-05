/** Vertical tab rail for the model-detail panel (mirrors detail/DetailSubRail's `SEGMENTS as const` pattern). */

export const MODEL_DETAIL_TABS = ["Overview", "Capabilities", "Limits + Vision", "Billing + Policy", "Telemetry", "Raw JSON"] as const

export type ModelDetailTab = (typeof MODEL_DETAIL_TABS)[number]

interface ModelDetailSubRailProps {
  active: ModelDetailTab
  onSelect: (tab: ModelDetailTab) => void
}

export function ModelDetailSubRail({ active, onSelect }: ModelDetailSubRailProps) {
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Model detail sections"
      className="mono flex w-[104px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[#14141a]"
    >
      {MODEL_DETAIL_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          onClick={() => onSelect(tab)}
          className={`px-2 py-1.5 text-left text-[12px] ${active === tab ? "bg-[#3a2f1a] text-[var(--color-primary)]" : "text-[#999] hover:text-[var(--color-text)]"}`}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}
