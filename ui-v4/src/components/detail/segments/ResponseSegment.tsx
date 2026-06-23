import type {
  //
  HistoryEntry,
  SseEventRecord,
} from "@/types"

import { SseFrameDiff } from "@/components/detail/diff/SseFrameDiff"
import { MessageBlock } from "@/components/detail/MessageBlock"
import { LegShell } from "@/components/detail/segments/LegShell"

function FrameList({ label, frames }: { label: string; frames: Array<SseEventRecord> }) {
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
            <span className="text-[var(--color-muted)]">[{f.offsetMs}]</span> <span className="text-[#9ad]">{f.type}</span> {f.raw}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ResponseSegment({ entry }: { entry: HistoryEntry }) {
  const upstreamFrames = entry.sseEvents ?? []
  const forwardedFrames = entry.inboundResponse?.sseEvents ?? []
  const hasUpstream = Boolean(entry.outboundResponse) || upstreamFrames.length > 0
  const hasForwarded = entry.inboundResponse?.content !== undefined || forwardedFrames.length > 0
  const hasAny = hasUpstream || hasForwarded

  if (!hasAny) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无响应数据</div>

  return (
    <div>
      {hasUpstream ?
        <LegShell label="Upstream (upstream → proxy)">
          <div className="mono mb-1 text-[13px] text-[#888]">
            status {entry.outboundResponse?.status ?? "—"} · {entry.outboundResponse?.model} · {entry.outboundResponse?.success ? "ok" : "fail"}
          </div>
          {entry.outboundResponse?.content ?
            <MessageBlock message={entry.outboundResponse.content} />
          : <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">
              {entry.outboundResponse?.rawBody ?? entry.outboundResponse?.error ?? "(no content)"}
            </pre>
          }
          {upstreamFrames.length > 0 ?
            <FrameList
              label="upstream sse"
              frames={upstreamFrames}
            />
          : null}
        </LegShell>
      : null}
      {hasForwarded ?
        <LegShell label="Forwarded (proxy → client)">
          {entry.inboundResponse?.content !== undefined ?
            <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{JSON.stringify(entry.inboundResponse.content, null, 2)}</pre>
          : null}
          {forwardedFrames.length > 0 ?
            <FrameList
              label="forwarded sse"
              frames={forwardedFrames}
            />
          : null}
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
