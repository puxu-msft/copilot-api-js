import { useMemo } from "react"

import type { MessageContent } from "@/lib/content/types"

import {
  //
  diffMessageList,
  diffStats,
} from "@/lib/diff/block-diff"

import { DiffRow } from "./DiffRow"

// Bound DOM cost: render only the first MAX_ROWS rows; the surrounding section's
// Raw view reaches the full data.
const MAX_ROWS = 400

interface MessageDiffViewProps {
  left: Array<MessageContent>
  right: Array<MessageContent>
}

function preview(m: MessageContent | undefined): string {
  if (!m) return ""
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null)
  return text.length > 160 ? text.slice(0, 157) + "…" : text
}

export function MessageDiffView({ left, right }: MessageDiffViewProps) {
  const rows = useMemo(() => diffMessageList(left, right), [left, right])
  const stats = useMemo(() => diffStats(rows), [rows])

  const visibleRows = rows.slice(0, MAX_ROWS)
  const hiddenCount = Math.max(0, rows.length - MAX_ROWS)

  return (
    <div>
      <div className="mono px-2 py-0.5 text-[11px] text-[var(--content-muted)]">
        {stats.modified}~ {stats.removed}− {stats.added}+ · {stats.same} unchanged
      </div>
      {visibleRows.map((row, i) => (
        <DiffRow
          key={i}
          kind={row.kind}
          label={row.role}
          bodyText={preview(row.right ?? row.left)}
          inlineParts={row.textDiff}
        />
      ))}
      {hiddenCount > 0 ?
        <div className="mono p-2 text-[13px] text-[var(--content-muted)]">+{hiddenCount} more messages.</div>
      : null}
    </div>
  )
}
