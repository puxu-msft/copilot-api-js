import { useMemo } from "react"

import type { SseEventRecord } from "@/types"

import {
  //
  diffSseFrames,
  diffStats,
} from "@/lib/diff/block-diff"

import { DiffRow } from "./DiffRow"

// Bound work: this view mounts whenever the Response segment is open, so the diff
// runs regardless of visibility. Skip it for pathologically large streams
// (worst-case O(N·D)), and cap rendered rows (DOM cost).
const MAX_INPUT = 4000
const MAX_ROWS = 400

interface SseFrameDiffProps {
  upstream: Array<SseEventRecord>
  forwarded: Array<SseEventRecord>
}

export function SseFrameDiff({ upstream, forwarded }: SseFrameDiffProps) {
  const oversized = upstream.length + forwarded.length > MAX_INPUT
  const rows = useMemo(() => (oversized ? [] : diffSseFrames(upstream, forwarded)), [oversized, upstream, forwarded])
  const stats = useMemo(() => diffStats(rows), [rows])

  if (upstream.length === 0 && forwarded.length === 0) return null

  if (oversized)
    return (
      <div className="mono p-2 text-[13px] text-[var(--content-muted)]">
        Stream too large to diff inline ({upstream.length} + {forwarded.length} frames).
      </div>
    )

  const visibleRows = rows.slice(0, MAX_ROWS)
  const hiddenCount = Math.max(0, rows.length - MAX_ROWS)

  return (
    <div>
      <div className="mono px-2 py-0.5 text-[11px] text-[var(--content-muted)]">
        {stats.modified}~ {stats.removed}− {stats.added}+
      </div>
      {visibleRows.map((row, i) => (
        <DiffRow
          key={i}
          kind={row.kind}
          label={row.type}
          bodyText={(row.forwarded ?? row.upstream)?.raw}
          inlineParts={row.rawDiff}
        />
      ))}
      {hiddenCount > 0 ?
        <div className="mono p-2 text-[13px] text-[var(--content-muted)]">+{hiddenCount} more frames.</div>
      : null}
    </div>
  )
}
