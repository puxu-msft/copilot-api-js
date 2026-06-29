import type { HistoryEntry } from "@/types"

import { MessageBlock } from "@/components/detail/MessageBlock"
import { LegShell } from "@/components/detail/segments/LegShell"

/**
 * Rendered/semantic response view: the upstream answer (proxy-recorded) and the
 * content actually forwarded to the client. The raw SSE wire frames + diff live
 * in the separate SSE tab (SseEventsSegment).
 */
export function ResponseSegment({ entry }: { entry: HistoryEntry }) {
  const hasUpstream = Boolean(entry.outboundResponse)
  const hasForwarded = entry.inboundResponse?.content !== undefined

  if (!hasUpstream && !hasForwarded) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无响应数据</div>

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
        </LegShell>
      : null}
      {hasForwarded ?
        <LegShell label="Forwarded (proxy → client)">
          <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{JSON.stringify(entry.inboundResponse?.content, null, 2)}</pre>
        </LegShell>
      : null}
    </div>
  )
}
