import { finalUpstreamResponse } from "~backend/lib/history/entry-view"

import type {
  //
  HistoryEntry,
  SseEventRecord,
} from "@/types"

import { SseFrameDiff } from "@/components/detail/diff/SseFrameDiff"
import { LegShell } from "@/components/detail/segments/LegShell"
import {
  //
  formatClockMs,
  formatElapsed,
} from "@/lib/format"

function FrameList({ label, frames, startedAt }: { label: string; frames: Array<SseEventRecord>; startedAt: number }) {
  return (
    <div className="mt-2">
      <div className="mono mb-1 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
        {label} ({frames.length} frames)
      </div>
      <div className="border border-[#1e1e24]">
        {frames.map((f, i) => (
          <div
            key={i}
            className="mono overflow-hidden text-ellipsis whitespace-nowrap px-2 py-0.5 text-[13px] text-[#aaa]"
          >
            <span className="text-[var(--color-muted)]">
              {formatClockMs(startedAt + f.offsetMs)} {formatElapsed(f.offsetMs)}
            </span>{" "}
            <span className="text-[#9ad]">{f.type}</span> {f.raw}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Raw SSE frame view: upstream-recorded frames, frames actually forwarded to the
 * client, and their alignment diff. Split out of ResponseSegment so the Response
 * tab stays the rendered/semantic answer while this tab carries the wire frames.
 */
export function SseEventsSegment({ entry }: { entry: HistoryEntry }) {
  // Upstream frames: new final-attempt `upstreamResponse.sseEvents` ?? legacy top-level `sseEvents`.
  // Forwarded frames: new `clientResponse.sseEvents` ?? legacy `inboundResponse.sseEvents` (P4c: drop legacy arms).
  const upstreamFrames = finalUpstreamResponse(entry)?.sseEvents ?? entry.sseEvents ?? []
  const forwardedFrames = entry.clientResponse?.sseEvents ?? entry.inboundResponse?.sseEvents ?? []

  if (upstreamFrames.length === 0 && forwardedFrames.length === 0)
    return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无 SSE 帧（非流式响应）</div>

  return (
    <div>
      {upstreamFrames.length > 0 ?
        <LegShell label="Upstream (upstream → proxy)">
          <FrameList
            label="upstream sse"
            frames={upstreamFrames}
            startedAt={entry.startedAt}
          />
        </LegShell>
      : null}
      {forwardedFrames.length > 0 ?
        <LegShell label="Forwarded (proxy → client)">
          <FrameList
            label="forwarded sse"
            frames={forwardedFrames}
            startedAt={entry.startedAt}
          />
        </LegShell>
      : null}
      <LegShell label="upstream vs forwarded">
        <SseFrameDiff
          upstream={upstreamFrames}
          forwarded={forwardedFrames}
        />
      </LegShell>
    </div>
  )
}
