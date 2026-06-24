import {
  //
  useEffect,
  useMemo,
  useState,
} from "react"

import type { TocNode } from "@/lib/content/toc"
import type { MessageContent } from "@/lib/content/types"
import type { RewriteMark } from "@/lib/diff/block-diff"
import type { HistoryEntry } from "@/types"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { ConversationView } from "@/components/detail/ConversationView"
import { MessageDiffView } from "@/components/detail/diff/MessageDiffView"
import { LegShell } from "@/components/detail/segments/LegShell"
import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"
import { TocSidebar } from "@/components/detail/toc/TocSidebar"
import { useAnchorScroll } from "@/hooks/useAnchorScroll"
import { buildMessageTocNodes } from "@/lib/content/toc"
import { deriveRewriteMarks } from "@/lib/diff/rewrite-marks"

type LegKey = "inbound" | "effective" | "wire"

interface Leg {
  key: LegKey
  label: string
  /** Short header label for the selected-leg pane. */
  shortLabel: string
  messages: Array<MessageContent>
  /** Full raw body for the Raw view. */
  rawPayload: unknown
  /** Per-message rewrite marks (inbound/effective only); undefined when this leg has no marks. */
  marks?: Array<RewriteMark | undefined>
}

/** Parse the leg key out of an anchor id (`stage-${key}` or `stage-${key}-msg-${i}`). */
function legKeyFromAnchor(anchorId: string): LegKey | undefined {
  const rest = anchorId.startsWith("stage-") ? anchorId.slice("stage-".length) : ""
  const key = rest.split("-")[0]
  return key === "inbound" || key === "effective" || key === "wire" ? key : undefined
}

export function StagesSegment({ entry }: { entry: HistoryEntry }) {
  const [showDiff, setShowDiff] = useState(false)
  const [rawMode, setRawMode] = useState(false)

  const inboundMessages = entry.inboundRequest.messages
  const effectiveMessages = entry.effectiveRequest?.messages
  const canDiff = inboundMessages !== undefined && effectiveMessages !== undefined

  const { inboundMarks, effectiveMarks } = useMemo(() => deriveRewriteMarks(inboundMessages, effectiveMessages), [inboundMessages, effectiveMessages])

  const legs: Array<Leg> = useMemo(() => {
    const built: Array<Leg | null> = [
      {
        key: "inbound",
        label: "Inbound (client → proxy)",
        shortLabel: "Inbound",
        messages: entry.inboundRequest.messages ?? [],
        rawPayload: entry.inboundRequest,
        marks: inboundMarks,
      },
      entry.effectiveRequest ?
        {
          key: "effective",
          label: "Effective (after rewrites)",
          shortLabel: "Effective",
          messages: entry.effectiveRequest.messages ?? [],
          rawPayload: entry.effectiveRequest.payload ?? entry.effectiveRequest,
          marks: effectiveMarks,
        }
      : null,
      entry.outboundRequest ?
        {
          key: "wire",
          label: "Wire (proxy → upstream)",
          shortLabel: "Wire",
          messages: entry.outboundRequest.messages ?? [],
          rawPayload: entry.outboundRequest.payload ?? entry.outboundRequest,
        }
      : null,
    ]
    return built.filter((leg): leg is Leg => leg !== null)
  }, [entry, inboundMarks, effectiveMarks])

  const [selectedLeg, setSelectedLeg] = useState<LegKey>("inbound")
  const [pendingScroll, setPendingScroll] = useState<string | undefined>(undefined)
  const { scrollTo, activeAnchor } = useAnchorScroll()

  // Switching legs re-renders the content pane; scroll to a message anchor only
  // once its leg has mounted. The effect fires after the selected leg renders.
  useEffect(() => {
    if (pendingScroll === undefined) return
    scrollTo(pendingScroll)
    setPendingScroll(undefined)
  }, [selectedLeg, pendingScroll, scrollTo])

  function handleSelect(anchorId: string): void {
    const key = legKeyFromAnchor(anchorId)
    if (key === undefined) return
    setSelectedLeg(key)
    // Only message anchors need a deferred in-leg scroll; leg-node clicks just switch.
    setPendingScroll(anchorId.includes("-msg-") ? anchorId : undefined)
  }

  const tocNodes: Array<TocNode> = legs.map((leg) => ({
    label: leg.shortLabel,
    anchorId: `stage-${leg.key}`,
    kind: "leg",
    children: buildMessageTocNodes(leg.messages, `stage-${leg.key}`),
  }))

  const leg = legs.find((l) => l.key === selectedLeg) ?? legs[0]
  // When no message is actively scrolled, the selected leg's node reads as active.
  const tocActiveAnchor = activeAnchor ?? `stage-${selectedLeg}`
  const hasMessages = leg.messages.length > 0
  const showRaw = rawMode || !hasMessages

  return (
    <div className="flex gap-2">
      {tocNodes.length > 0 ?
        <TocSidebar>
          <DetailTocTree
            nodes={tocNodes}
            onSelect={handleSelect}
            activeAnchor={tocActiveAnchor}
          />
        </TocSidebar>
      : null}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="mono text-[11px] uppercase tracking-wider text-[var(--color-primary)]">{leg.label}</span>
          <button
            type="button"
            onClick={() => setRawMode(false)}
            className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${showRaw ? "" : "text-[var(--color-primary)]"}`}
          >
            Rendered
          </button>
          <button
            type="button"
            onClick={() => setRawMode(true)}
            className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${showRaw ? "text-[var(--color-primary)]" : ""}`}
          >
            Raw
          </button>
          {canDiff ?
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className={`mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] ${showDiff ? "text-[var(--color-warn)]" : "text-[var(--color-primary)]"}`}
            >
              ↔ show full diff
            </button>
          : null}
        </div>
        {canDiff && showDiff ?
          <LegShell label="Inbound ↔ Effective diff">
            <MessageDiffView
              left={inboundMessages}
              right={effectiveMessages}
            />
          </LegShell>
        : null}
        <div
          id={`stage-${leg.key}`}
          className="min-w-0"
        >
          <LegShell label={leg.label}>
            {showRaw ?
              <CodeBlock
                code={JSON.stringify(leg.rawPayload, null, 2)}
                lang="json"
              />
            : <ConversationView
                messages={leg.messages}
                anchorPrefix={`stage-${leg.key}`}
                marks={leg.marks}
              />
            }
          </LegShell>
        </div>
      </div>
    </div>
  )
}
