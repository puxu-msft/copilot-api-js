import { useState } from "react"

import type { MessageContent } from "@/lib/content/types"
import type { HistoryEntry } from "@/types"

import { ConversationView } from "@/components/detail/ConversationView"
import { MessageDiffView } from "@/components/detail/diff/MessageDiffView"
import { LegShell } from "@/components/detail/segments/LegShell"

function RequestLegBody({ messages, fallback }: { messages?: Array<MessageContent>; fallback?: unknown }) {
  if (messages) return <ConversationView messages={messages} />
  return <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{JSON.stringify(fallback, null, 2)}</pre>
}

export function StagesSegment({ entry }: { entry: HistoryEntry }) {
  const [showDiff, setShowDiff] = useState(false)
  const inboundMessages = entry.inboundRequest.messages
  const effectiveMessages = entry.effectiveRequest?.messages
  const canDiff = inboundMessages !== undefined && effectiveMessages !== undefined

  return (
    <div>
      {canDiff ?
        <>
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className={`mono mb-2 border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${showDiff ? "text-[var(--color-warn)]" : "text-[var(--color-primary)]"}`}
          >
            ↔ inbound vs effective diff
          </button>
          {showDiff ?
            <LegShell label="Inbound ↔ Effective diff">
              <MessageDiffView
                left={inboundMessages}
                right={effectiveMessages}
              />
            </LegShell>
          : null}
        </>
      : null}
      <div className="@container">
        <div className="grid grid-cols-1 gap-2 @4xl:grid-cols-3">
          <div className="min-w-0">
            <LegShell label="Inbound (client → proxy)">
              <RequestLegBody messages={entry.inboundRequest.messages ?? []} />
            </LegShell>
          </div>
          {entry.effectiveRequest ?
            <div className="min-w-0">
              <LegShell label="Effective (after rewrites)">
                <RequestLegBody
                  messages={entry.effectiveRequest.messages}
                  fallback={entry.effectiveRequest.payload ?? entry.effectiveRequest}
                />
              </LegShell>
            </div>
          : null}
          {entry.outboundRequest ?
            <div className="min-w-0">
              <LegShell label="Wire (proxy → upstream)">
                <RequestLegBody
                  messages={entry.outboundRequest.messages}
                  fallback={entry.outboundRequest.payload ?? entry.outboundRequest}
                />
              </LegShell>
            </div>
          : null}
        </div>
      </div>
    </div>
  )
}
