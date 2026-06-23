import type { ReactNode } from "react"

import type { HistoryEntry } from "@/types"

import { ConversationView } from "@/components/detail/ConversationView"
import { MessageBlock } from "@/components/detail/MessageBlock"

function LegShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 border border-[var(--color-border)]">
      <div className="mono bg-[#1a1a1f] px-2 py-1 text-[11px] uppercase tracking-wider text-[var(--color-primary)]">{label}</div>
      <div className="p-2">{children}</div>
    </div>
  )
}

export function StagesSegment({ entry }: { entry: HistoryEntry }) {
  return (
    <div>
      <LegShell label="Inbound (client → proxy)">
        <ConversationView messages={entry.inboundRequest.messages ?? []} />
      </LegShell>
      {entry.effectiveRequest ?
        <LegShell label="Effective (after rewrites)">
          {entry.effectiveRequest.messages ?
            <ConversationView messages={entry.effectiveRequest.messages} />
          : <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">
              {JSON.stringify(entry.effectiveRequest.payload ?? entry.effectiveRequest, null, 2)}
            </pre>
          }
        </LegShell>
      : null}
      {entry.outboundRequest ?
        <LegShell label="Wire (proxy → upstream)">
          {entry.outboundRequest.messages ?
            <ConversationView messages={entry.outboundRequest.messages} />
          : <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">
              {JSON.stringify(entry.outboundRequest.payload ?? entry.outboundRequest, null, 2)}
            </pre>
          }
        </LegShell>
      : null}
      {entry.outboundResponse ?
        <LegShell label="Upstream (upstream → proxy)">
          <div className="mono mb-1 text-[13px] text-[#888]">
            status {entry.outboundResponse.status ?? "—"} · {entry.outboundResponse.model} · {entry.outboundResponse.success ? "ok" : "fail"}
          </div>
          {entry.outboundResponse.content ?
            <MessageBlock message={entry.outboundResponse.content} />
          : <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">
              {entry.outboundResponse.rawBody ?? entry.outboundResponse.error ?? "(no content)"}
            </pre>
          }
        </LegShell>
      : null}
      {entry.inboundResponse ?
        <LegShell label="Forwarded (proxy → client)">
          <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">
            {JSON.stringify(entry.inboundResponse.content ?? `(${entry.inboundResponse.sseEvents?.length ?? 0} sse frames)`, null, 2)}
          </pre>
        </LegShell>
      : null}
    </div>
  )
}
