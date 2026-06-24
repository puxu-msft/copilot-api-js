import { useState } from "react"

import type { TocNode } from "@/lib/content/toc"
import type { MessageContent } from "@/lib/content/types"
import type { HistoryEntry } from "@/types"

import { ConversationView } from "@/components/detail/ConversationView"
import { MessageDiffView } from "@/components/detail/diff/MessageDiffView"
import { LegShell } from "@/components/detail/segments/LegShell"
import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"
import { TocSidebar } from "@/components/detail/toc/TocSidebar"
import { useAnchorScroll } from "@/hooks/useAnchorScroll"
import { buildMessageTocNodes } from "@/lib/content/toc"

function RequestLegBody({ messages, fallback, anchorPrefix }: { messages?: Array<MessageContent>; fallback?: unknown; anchorPrefix?: string }) {
  if (messages)
    return (
      <ConversationView
        messages={messages}
        anchorPrefix={anchorPrefix}
      />
    )
  return <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{JSON.stringify(fallback, null, 2)}</pre>
}

interface Leg {
  key: "inbound" | "effective" | "wire"
  label: string
  messages: Array<MessageContent>
}

export function StagesSegment({ entry }: { entry: HistoryEntry }) {
  const [showDiff, setShowDiff] = useState(false)
  const inboundMessages = entry.inboundRequest.messages
  const effectiveMessages = entry.effectiveRequest?.messages
  const canDiff = inboundMessages !== undefined && effectiveMessages !== undefined

  const { scrollTo, activeAnchor } = useAnchorScroll()
  const legs: Array<Leg> = [
    { key: "inbound", label: "Inbound", messages: entry.inboundRequest.messages ?? [] },
    entry.effectiveRequest ? { key: "effective", label: "Effective", messages: entry.effectiveRequest.messages ?? [] } : null,
    entry.outboundRequest ? { key: "wire", label: "Wire", messages: entry.outboundRequest.messages ?? [] } : null,
  ].filter((leg): leg is Leg => leg !== null)
  const tocNodes: Array<TocNode> = legs.map((leg) => ({
    label: leg.label,
    anchorId: `stage-${leg.key}`,
    kind: "leg",
    children: buildMessageTocNodes(leg.messages, `stage-${leg.key}`),
  }))

  return (
    <div className="flex gap-2">
      {tocNodes.length > 0 ?
        <TocSidebar>
          <DetailTocTree
            nodes={tocNodes}
            onSelect={scrollTo}
            activeAnchor={activeAnchor}
          />
        </TocSidebar>
      : null}
      <div className="min-w-0 flex-1">
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
            <div
              id="stage-inbound"
              className="min-w-0"
            >
              <LegShell label="Inbound (client → proxy)">
                <RequestLegBody
                  messages={entry.inboundRequest.messages ?? []}
                  anchorPrefix="stage-inbound"
                />
              </LegShell>
            </div>
            {entry.effectiveRequest ?
              <div
                id="stage-effective"
                className="min-w-0"
              >
                <LegShell label="Effective (after rewrites)">
                  <RequestLegBody
                    messages={entry.effectiveRequest.messages}
                    fallback={entry.effectiveRequest.payload ?? entry.effectiveRequest}
                    anchorPrefix="stage-effective"
                  />
                </LegShell>
              </div>
            : null}
            {entry.outboundRequest ?
              <div
                id="stage-wire"
                className="min-w-0"
              >
                <LegShell label="Wire (proxy → upstream)">
                  <RequestLegBody
                    messages={entry.outboundRequest.messages}
                    fallback={entry.outboundRequest.payload ?? entry.outboundRequest}
                    anchorPrefix="stage-wire"
                  />
                </LegShell>
              </div>
            : null}
          </div>
        </div>
      </div>
    </div>
  )
}
