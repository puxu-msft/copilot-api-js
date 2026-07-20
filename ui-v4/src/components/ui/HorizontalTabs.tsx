import type { ReactNode } from "react"

import {
  //
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

/**
 * Horizontal Tabs content-layout primitive (RFC §4 C7 / round2-A2, decision 10).
 *
 * A thin, declarative wrapper over the shadcn `components/ui/tabs` primitives that
 * fixes the **horizontal** orientation: a tab list rendered above its content
 * panel (`Tabs` root uses `data-horizontal:flex-col`). This is the ONE真共享 shape
 * distilled from the two迥异 detail interaction models —
 *   - `detail/DetailPanel` (inline full-page, vertical sub-rail, 7 segments), and
 *   - `models/ModelDetail` (Radix Dialog drawer + Portal + Overlay + resize +
 *     focus-trap, 6 tabs).
 * round2-A2 撤销了 the earlier "DetailContainer" over-abstraction: the two drawer /
 * full-page **chrome** models must NOT be merged into one boolean-mode container.
 * Only the竖→横 tab layout is shared, so that (and nothing else) lives here. This
 * primitive intentionally contains **no** Dialog / Portal / Overlay / resize /
 * focus-trap and **no** `designVersion` — the drawer chrome and the full-page chrome
 * each stay in their own component and merely embed this layout.
 *
 * Consumers (shadcn-side, wired in P3 for Requests detail and P4 for Models drawer)
 * pass their segments declaratively as `{ value, label, content }`; the roving
 * tabindex, keyboard nav, and tab↔panel aria are Radix's (via the shadcn `Tabs`).
 *
 * Not yet wired to any legacy component — legacy `DetailPanel` / `ModelDetail` /
 * `DetailSubRail` / `ModelDetailSubRail` are frozen (OQ-1) and untouched by C7.
 */
export interface HorizontalTabItem {
  /** Stable tab identity; also the `Tabs` value used for selection. */
  value: string
  /** Trigger label — plain text or a node (e.g. icon + text). */
  label: ReactNode
  /** Panel body rendered when this tab is active. */
  content: ReactNode
  /** Optional per-trigger disabled state. */
  disabled?: boolean
}

export interface HorizontalTabsProps {
  /** Ordered segments; each becomes a `TabsTrigger` + its `TabsContent`. */
  tabs: Array<HorizontalTabItem>
  /** Controlled active tab value (pair with `onValueChange`). */
  value?: string
  /** Uncontrolled initial active tab value. */
  defaultValue?: string
  /** Fired with the tab value on selection change (both controlled + uncontrolled). */
  onValueChange?: (value: string) => void
  /** Accessible name for the tab list. */
  listAriaLabel?: string
  /** shadcn tabs-list visual variant. */
  listVariant?: "default" | "line"
  /** Extra classes on the `Tabs` root (the horizontal flex column). */
  className?: string
  /** Extra classes on the `TabsList`. */
  listClassName?: string
  /** Extra classes applied to every `TabsContent` pane. */
  contentClassName?: string
}

export function HorizontalTabs({
  tabs,
  value,
  defaultValue,
  onValueChange,
  listAriaLabel,
  listVariant = "default",
  className,
  listClassName,
  contentClassName,
}: HorizontalTabsProps) {
  return (
    <Tabs
      // Orientation is fixed horizontal — that is the whole point of this primitive.
      orientation="horizontal"
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      className={cn("min-h-0", className)}
    >
      <TabsList
        aria-label={listAriaLabel}
        variant={listVariant}
        className={listClassName}
      >
        {tabs.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            disabled={t.disabled}
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent
          key={t.value}
          value={t.value}
          className={cn("min-h-0", contentClassName)}
        >
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
