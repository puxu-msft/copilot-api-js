import type { HistoryEntry } from "@/types"

import { SystemMessage } from "@/components/detail/blocks/SystemMessage"
import { ConversationView } from "@/components/detail/ConversationView"
import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"
import { useAnchorScroll } from "@/hooks/useAnchorScroll"
import { buildMessageTocNodes } from "@/lib/content/toc"

const ANCHOR_PREFIX = "convo"

export function ConvoSegment({ entry }: { entry: HistoryEntry }) {
  const system = entry.inboundRequest.system
  const messages = entry.inboundRequest.messages ?? []
  const { scrollTo, activeAnchor } = useAnchorScroll()
  const nodes = buildMessageTocNodes(messages, ANCHOR_PREFIX)

  return (
    <div className="flex gap-2">
      {messages.length > 0 ?
        <nav className="sticky top-0 max-h-[calc(100vh-200px)] w-[200px] shrink-0 self-start overflow-auto border-r border-[var(--color-border)] pr-1">
          <DetailTocTree
            nodes={nodes}
            onSelect={scrollTo}
            activeAnchor={activeAnchor}
          />
        </nav>
      : null}
      <div className="min-w-0 flex-1">
        {system ?
          <SystemMessage
            system={system}
            rewrittenSystem={entry.effectiveRequest?.system}
          />
        : null}
        <ConversationView
          messages={messages}
          anchorPrefix={ANCHOR_PREFIX}
        />
      </div>
    </div>
  )
}
