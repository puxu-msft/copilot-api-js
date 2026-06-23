const SEGMENTS = ["Convo", "Stages", "Headers", "Meta"] as const

export type SegmentName = (typeof SEGMENTS)[number]

interface DetailSubRailProps {
  active: SegmentName
  onSelect: (s: SegmentName) => void
}

export function DetailSubRail({ active, onSelect }: DetailSubRailProps) {
  return (
    <div className="mono flex w-[84px] flex-col border-r border-[var(--color-border)] bg-[#14141a]">
      {SEGMENTS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSelect(s)}
          className={`px-2 py-1.5 text-left text-[12px] ${active === s ? "bg-[#3a2f1a] text-[var(--color-primary)]" : "text-[#999]"}`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

export { SEGMENTS }
