import { Tabs } from "radix-ui"

const SEGMENTS = ["Convo", "System", "Stages", "Response", "SSE", "Headers", "Meta"] as const

export type SegmentName = (typeof SEGMENTS)[number]

/**
 * Vertical segment rail for the request-detail panel, as a Radix `Tabs.List`.
 * State (active segment, roving tabindex, keyboard nav, tab↔panel aria) is owned
 * by the enclosing `Tabs.Root` in DetailPanel — Radix provides it. Terminal Amber
 * active styling rides on `data-[state=active]` (see docs/radix-styling.md).
 */
export function DetailSubRail() {
  return (
    <Tabs.List
      aria-label="Request detail segments"
      className="mono flex w-[84px] flex-col border-r border-[var(--color-border)] bg-[#14141a]"
    >
      {SEGMENTS.map((s) => (
        <Tabs.Trigger
          key={s}
          value={s}
          className="px-2 py-1.5 text-left text-[12px] text-[#999] hover:text-[var(--color-text)] data-[state=active]:bg-[#3a2f1a] data-[state=active]:text-[var(--color-primary)]"
        >
          {s}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  )
}

export { SEGMENTS }
