import { useRef } from "react"

/** Vertical tab rail for the model-detail panel (mirrors detail/DetailSubRail's `SEGMENTS as const` pattern). */

export const MODEL_DETAIL_TABS = ["Overview", "Capabilities", "Limits + Vision", "Billing + Policy", "Telemetry", "Raw JSON"] as const

export type ModelDetailTab = (typeof MODEL_DETAIL_TABS)[number]

/** id of the panel the tabs control (for `aria-controls` / `aria-labelledby` wiring). */
export const MODEL_DETAIL_PANEL_ID = "model-detail-panel"

/** Stable DOM id for a tab button, so the panel can point back at the active tab via `aria-labelledby`. */
export function tabId(tab: ModelDetailTab): string {
  return `model-detail-tab-${tab.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`
}

interface ModelDetailSubRailProps {
  active: ModelDetailTab
  onSelect: (tab: ModelDetailTab) => void
}

/**
 * Follows the WAI-ARIA vertical Tabs pattern: roving tabindex (only the active
 * tab is Tab-focusable) + Up/Down/Home/End arrow navigation with automatic
 * activation (moving focus also selects). Each tab is wired to the panel via
 * `aria-controls`; the panel points back via `aria-labelledby` ({@link tabId}).
 */
export function ModelDetailSubRail({ active, onSelect }: ModelDetailSubRailProps) {
  const railRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = MODEL_DETAIL_TABS.length - 1
    const idx = MODEL_DETAIL_TABS.indexOf(active)
    let next: number
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight": {
        next = idx >= last ? 0 : idx + 1
        break
      }
      case "ArrowUp":
      case "ArrowLeft": {
        next = idx <= 0 ? last : idx - 1
        break
      }
      case "Home": {
        next = 0
        break
      }
      case "End": {
        next = last
        break
      }
      default: {
        return
      }
    }
    e.preventDefault()
    onSelect(MODEL_DETAIL_TABS[next])
    // All tab buttons are rendered, so focusing by index works immediately
    // (independent of the pending re-render).
    railRef.current?.querySelector<HTMLButtonElement>(`[data-tab-index="${next}"]`)?.focus()
  }

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Model detail sections"
      onKeyDown={onKeyDown}
      className="mono flex w-[104px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[#14141a]"
    >
      {MODEL_DETAIL_TABS.map((tab, i) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={tabId(tab)}
          data-tab-index={i}
          aria-selected={active === tab}
          aria-controls={MODEL_DETAIL_PANEL_ID}
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onSelect(tab)}
          className={`px-2 py-1.5 text-left text-[12px] ${active === tab ? "bg-[#3a2f1a] text-[var(--color-primary)]" : "text-[#999] hover:text-[var(--color-text)]"}`}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}
