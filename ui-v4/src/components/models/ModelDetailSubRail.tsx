import { Tabs } from "radix-ui"

/** Vertical tab rail for the model-detail panel, built on Radix `Tabs.List` (headless). */

export const MODEL_DETAIL_TABS = ["Overview", "Capabilities", "Limits + Vision", "Billing + Policy", "Telemetry", "Raw JSON"] as const

export type ModelDetailTab = (typeof MODEL_DETAIL_TABS)[number]

/**
 * The tab rail as a Radix `Tabs.List` of `Tabs.Trigger`s. State (active tab,
 * roving tabindex, Up/Down/Home/End keyboard nav, tab↔panel `aria-controls`/
 * `aria-labelledby` wiring) is owned by the enclosing `Tabs.Root` in ModelDetail
 * — Radix provides all of it, so the previous hand-rolled roving/arrow handling
 * is gone. Terminal Amber active styling rides on `data-[state=active]`
 * (see docs/radix-styling.md).
 */
export function ModelDetailSubRail() {
  return (
    <Tabs.List
      aria-label="Model detail sections"
      className="mono flex w-[104px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[#14141a]"
    >
      {MODEL_DETAIL_TABS.map((tab) => (
        <Tabs.Trigger
          key={tab}
          value={tab}
          className="px-2 py-1.5 text-left text-[12px] text-[#999] hover:text-[var(--color-text)] data-[state=active]:bg-[#3a2f1a] data-[state=active]:text-[var(--color-primary)]"
        >
          {tab}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  )
}
