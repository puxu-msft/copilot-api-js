import {
  //
  useMemo,
  useState,
} from "react"

import type { HistoryEntry } from "@/types"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { ConversationView } from "@/components/detail/ConversationView"
import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"
import { TocSidebar } from "@/components/detail/toc/TocSidebar"
import { ToolPairingProvider } from "@/components/detail/ToolPairingContext"
import { useAnchorScroll } from "@/hooks/useAnchorScroll"
import { buildMessageTocNodes } from "@/lib/content/toc"
import { buildToolPairing } from "@/lib/content/tool-pairing"

const ANCHOR_PREFIX = "convo"

type ConvoView = "rendered" | "raw"

const TOGGLE_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

function viewClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`
}

export function ConvoSegment({ entry }: { entry: HistoryEntry }) {
  const [view, setView] = useState<ConvoView>("rendered")
  // `?? []` yields a fresh array each render; memoize so the derived-TOC useMemos
  // below (deps [messages]) don't recompute every render.
  const messages = useMemo(() => entry.inboundRequest.messages ?? [], [entry.inboundRequest.messages])
  const { scrollTo, activeAnchor } = useAnchorScroll()
  const nodes = useMemo(() => buildMessageTocNodes(messages, ANCHOR_PREFIX), [messages])
  const pairing = useMemo(() => buildToolPairing(messages, ANCHOR_PREFIX), [messages])

  return (
    <div className="flex gap-2">
      {view === "rendered" && messages.length > 0 ?
        <TocSidebar>
          <DetailTocTree
            // Reset expand/collapse state per request — otherwise the prior entry's
            // collapsed anchors leak in and defeat the default-expanded intent.
            key={entry.id}
            nodes={nodes}
            onSelect={scrollTo}
            activeAnchor={activeAnchor}
            defaultExpanded
            showExpandAllToggle
          />
        </TocSidebar>
      : null}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView("rendered")}
            className={viewClass(view === "rendered")}
          >
            Rendered
          </button>
          <button
            type="button"
            onClick={() => setView("raw")}
            className={viewClass(view === "raw")}
          >
            Raw body
          </button>
        </div>
        {view === "raw" ?
          <>
            <div className="mono mb-1.5 text-[11px] text-[var(--color-muted)]">
              仅消息数组。完整请求 body（system · tools · 参数）见 Stages → Inbound → Raw。
            </div>
            <CodeBlock
              code={JSON.stringify(messages, null, 2)}
              lang="json"
            />
          </>
        : <ToolPairingProvider value={{ pairing, scrollTo }}>
            <ConversationView
              messages={messages}
              anchorPrefix={ANCHOR_PREFIX}
            />
          </ToolPairingProvider>
        }
      </div>
    </div>
  )
}
