import type { EntryStatus } from "@/types"

import { badgeKind } from "@/lib/learned"

const STYLE: Record<"active" | "expired" | "pinned", { label: string; color: string }> = {
  active: { label: "● 活跃", color: "var(--signal-ok)" },
  expired: { label: "● 已过期", color: "var(--signal-muted)" },
  pinned: { label: "◆ 已固定", color: "var(--content-accent)" },
}

export function StatusBadge({ status }: { status: EntryStatus }) {
  const s = STYLE[badgeKind(status)]
  return (
    <span
      className="mono inline-block text-[11px]"
      style={{ color: s.color }}
      title={status}
    >
      {s.label}
    </span>
  )
}
