import { finalAttempt } from "~backend/lib/history/entry-view"
import {
  //
  useMemo,
  useState,
} from "react"

import type { HistoryEntry } from "@/types"

import { RawJsonView } from "@/components/common/RawJsonView"
import {
  //
  SystemMessage,
  systemToBlocks,
  type ViewMode,
} from "@/components/detail/blocks/SystemMessage"
import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"
import { TocSidebar } from "@/components/detail/toc/TocSidebar"
import { useAnchorScroll } from "@/hooks/useAnchorScroll"
import { buildSystemTocNodes } from "@/lib/content/toc"

const ANCHOR_PREFIX = "system"

type SystemView = "rendered" | "raw"

const TOGGLE_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

function viewClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`
}

/**
 * Dedicated segment for the request's system prompt(s), split out of the Convo
 * segment so each renders in its richest form: Convo owns the message turns, this
 * owns the system payload. The Rendered view reuses `SystemMessage` — string /
 * SystemBlock[] / cache_control labels / inbound→effective original·rewritten·diff,
 * including `removed`/`added` when a rewrite drops or injects the whole system.
 * Raw exposes the untouched system JSON (block structure + cache_control). A
 * multi-block system also gets a left TOC (gated to the original view, whose
 * blocks it anchors). The full inbound request body lives under Stages → Inbound → Raw.
 */
export function SystemSegment({ entry }: { entry: HistoryEntry }) {
  const [view, setView] = useState<SystemView>("rendered")
  // Mirror of SystemMessage's internal view mode, so the TOC (which anchors the
  // ORIGINAL blocks) only shows while the original view is active — avoiding
  // stale/misaligned targets in the rewritten/diff views.
  const [systemMode, setSystemMode] = useState<ViewMode>("original")
  const { scrollTo, activeAnchor } = useAnchorScroll()

  // Effective (post-rewrite) source: new final-attempt `effectiveSource` (legacy top-level `effectiveRequest` removed in P4c).
  // Inbound (client) system comes from the `clientRequest` structured projection.
  const effectiveSource = finalAttempt(entry)?.effectiveSource
  const inboundSystem = entry.clientRequest?.system
  const effectiveSystem = effectiveSource?.system
  const hasEffective = effectiveSource !== undefined
  const originalPresent = inboundSystem !== undefined

  // TOC reflects the inbound (original) block structure; string / single-block
  // systems need no navigation. Built regardless of view so hooks stay unconditional.
  const originalBlocks = useMemo(() => (inboundSystem === undefined ? [] : systemToBlocks(inboundSystem)), [inboundSystem])
  const nodes = useMemo(() => buildSystemTocNodes(originalBlocks, ANCHOR_PREFIX), [originalBlocks])

  // No system on either leg → nothing to show. A present-but-empty system ("" or
  // []) is a real client-sent payload and is rendered as-is, not hidden: an
  // explicit empty system is distinct from a missing one (richest-data-flow).
  if (inboundSystem === undefined && effectiveSystem === undefined) {
    return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无 system prompt</div>
  }

  const showToc = view === "rendered" && systemMode === "original" && originalBlocks.length > 1
  // Raw shows whichever leg carries the system (inbound preferred; effective when
  // the system was only added by a rewrite). Two-leg comparison lives in the
  // rendered Diff view and in Stages → Inbound/Effective → Raw.
  const rawFromEffective = inboundSystem === undefined && effectiveSystem !== undefined
  const rawSystem = inboundSystem ?? effectiveSystem

  return (
    <div className="flex gap-2">
      {showToc ?
        <TocSidebar>
          <DetailTocTree
            nodes={nodes}
            onSelect={scrollTo}
            activeAnchor={activeAnchor}
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
              {rawFromEffective ? "effective system（inbound 无 system，此为 rewrite 注入）" : "inbound system"}。两腿完整对比见上方 Diff 视图或 Stages →
              Inbound/Effective → Raw。
            </div>
            {typeof rawSystem === "string" ?
              <pre className="mono whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{rawSystem}</pre>
            : <RawJsonView value={rawSystem} />}
          </>
        : <SystemMessage
            system={inboundSystem ?? ""}
            rewrittenSystem={effectiveSystem}
            hasEffective={hasEffective}
            originalPresent={originalPresent}
            anchorPrefix={ANCHOR_PREFIX}
            onModeChange={setSystemMode}
          />
        }
      </div>
    </div>
  )
}
