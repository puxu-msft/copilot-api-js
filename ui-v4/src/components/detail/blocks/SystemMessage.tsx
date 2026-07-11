import { useState } from "react"

import type { SystemBlock } from "@/types"

import { UnifiedLineDiff } from "@/components/detail/diff/UnifiedLineDiff"
import { LineNumberedText } from "@/components/detail/LineNumberedText"
import { systemBlockAnchorId } from "@/lib/content/anchors"
import { diffLinesRich } from "@/lib/diff/block-diff"

export type SystemValue = string | Array<SystemBlock>
export type ViewMode = "original" | "rewritten" | "diff"

/** How the effective (post-rewrite) system relates to the inbound one. */
type RewriteKind = "none" | "unchanged" | "modified" | "removed" | "added"

interface SystemMessageProps {
  system: SystemValue
  rewrittenSystem?: SystemValue | null
  /**
   * True when an effective (post-rewrite) leg exists at all. Paired with
   * `originalPresent`, it lets `removed`/`added` be told apart from a plain
   * text change: `hasEffective` = does the effective leg exist, `rewrittenSystem`
   * = what system (if any) that leg carries — two distinct dimensions, not
   * redundant. When omitted, presence is inferred from `rewrittenSystem` (back-compat).
   */
  hasEffective?: boolean
  /**
   * Whether the INBOUND system field is present at all (vs. absent and only
   * added by a rewrite). Defaults to true, since `system` is normally a real
   * inbound payload; SystemSegment passes false for the added case so the
   * empty-original is classified as `added` rather than a text `modified`.
   */
  originalPresent?: boolean
  /**
   * When set, each rendered system block gets DOM id `${anchorPrefix}-blk-${i}`
   * for TOC scroll-to navigation (see `buildSystemTocNodes`). Only the original
   * view attaches these; the TOC is gated to the original mode by the parent.
   */
  anchorPrefix?: string
  /** Notifies the parent when the internal view mode changes (TOC↔mode sync). */
  onModeChange?: (mode: ViewMode) => void
}

function systemToText(system: SystemValue): string {
  if (typeof system === "string") return system
  return system.map((b) => b.text).join("\n")
}

/** Normalize a system payload to its block array (string → single text block). */
export function systemToBlocks(system: SystemValue): Array<SystemBlock> {
  if (typeof system === "string") return [{ type: "text", text: system }]
  return system
}

/** One block of a system payload, with `text[i]` + `[cache: type]` labels when relevant. */
function SystemBlocksBody({ blocks, anchorPrefix }: { blocks: Array<SystemBlock>; anchorPrefix?: string }) {
  const multiple = blocks.length > 1
  return (
    <div>
      {blocks.map((block, i) => (
        <div
          key={i}
          id={anchorPrefix !== undefined ? systemBlockAnchorId(anchorPrefix, i) : undefined}
          className={multiple ? "mb-2 border border-[var(--surface-border)] p-1.5 last:mb-0" : ""}
        >
          {multiple || block.cache_control ?
            <div className="mono mb-1 flex items-center gap-2 text-[11px] text-[var(--content-muted)]">
              {multiple ?
                <span>text[{i}]</span>
              : null}
              {block.cache_control ?
                <span className="italic text-[var(--signal-warn)]">[cache: {block.cache_control.type}]</span>
              : null}
            </div>
          : null}
          <div className="text-[var(--content-text)]">
            <LineNumberedText text={block.text} />
          </div>
        </div>
      ))}
    </div>
  )
}

const TOGGLE_BASE = "mono border border-[var(--surface-border)] px-2 py-0.5 text-[12px]"

function modeClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--content-accent)]" : "text-[var(--content-muted)]"}`
}

/**
 * Classify how the effective system relates to the inbound one. Presence is a
 * dimension the text projection can't carry (an absent leg and an empty-string
 * system both project to ""), so `removed`/`added` are decided by presence flags
 * first, and only then does text drive `unchanged`/`modified`.
 */
function classifyRewrite(opts: {
  hasRewrite: boolean
  originalPresent: boolean
  effectivePresent: boolean
  originalText: string
  rewrittenText: string
}): RewriteKind {
  const { hasRewrite, originalPresent, effectivePresent, originalText, rewrittenText } = opts
  if (!hasRewrite) return "none"
  if (!originalPresent && effectivePresent) return "added"
  if (originalPresent && !effectivePresent) return "removed"
  if (originalText === rewrittenText) return "unchanged"
  return "modified"
}

/** Badge vocabulary for how the effective system relates to inbound. */
function RewriteBadge({ kind }: { kind: RewriteKind }) {
  switch (kind) {
    case "removed": {
      return <span className="mono text-[11px] text-[var(--content-del)]">removed</span>
    }
    case "added": {
      return <span className="mono text-[11px] text-[var(--content-add)]">added</span>
    }
    case "modified": {
      return <span className="mono text-[11px] text-[var(--signal-warn)]">modified</span>
    }
    case "unchanged": {
      return <span className="mono text-[11px] text-[var(--content-muted)]">rewritten</span>
    }
    default: {
      return null
    }
  }
}

interface SystemBodyProps {
  mode: ViewMode
  hasRewrite: boolean
  originalBlocks: Array<SystemBlock>
  rewrittenBlocks: Array<SystemBlock>
  originalText: string
  rewrittenText: string
  anchorPrefix?: string
}

function SystemBody({ mode, hasRewrite, originalBlocks, rewrittenBlocks, originalText, rewrittenText, anchorPrefix }: SystemBodyProps) {
  if (!hasRewrite || mode === "original")
    return (
      <SystemBlocksBody
        blocks={originalBlocks}
        anchorPrefix={anchorPrefix}
      />
    )
  if (mode === "rewritten")
    // The TOC anchors the ORIGINAL blocks only (parent gates it to the original
    // mode), so rewritten blocks deliberately carry no anchor ids — no collision,
    // no stale TOC target.
    return <SystemBlocksBody blocks={rewrittenBlocks} />
  return (
    <>
      {originalBlocks.length !== rewrittenBlocks.length ?
        <div className="mono mb-1 text-[11px] font-semibold text-[var(--signal-warn)]">
          Block count changed: {originalBlocks.length} → {rewrittenBlocks.length}
        </div>
      : null}
      <UnifiedLineDiff rows={diffLinesRich(originalText, rewrittenText)} />
    </>
  )
}

export function SystemMessage({ system, rewrittenSystem, hasEffective, originalPresent = true, anchorPrefix, onModeChange }: SystemMessageProps) {
  const effectivePresent = rewrittenSystem !== undefined && rewrittenSystem !== null
  // An effective leg may exist yet carry no system (a removed rewrite), so prefer
  // the explicit flag; fall back to inferring presence from rewrittenSystem.
  const hasRewrite = hasEffective ?? effectivePresent

  const [collapsed, setCollapsed] = useState(false)
  // The `added` case (inbound had no system) has an empty original view, so open
  // on Rewritten where the injected system actually lives.
  const [mode, setMode] = useState<ViewMode>(() => (hasRewrite && !originalPresent && effectivePresent ? "rewritten" : "original"))

  function changeMode(next: ViewMode): void {
    setMode(next)
    onModeChange?.(next)
  }

  const originalText = systemToText(system)
  const rewrittenText = rewrittenSystem ? systemToText(rewrittenSystem) : ""
  const rewriteKind = classifyRewrite({ hasRewrite, originalPresent, effectivePresent, originalText, rewrittenText })

  const originalBlocks = systemToBlocks(system)
  const rewrittenBlocks = rewrittenSystem ? systemToBlocks(rewrittenSystem) : []
  const hasCacheControl = originalBlocks.some((b) => b.cache_control)

  return (
    <div className="mb-2 border border-[var(--surface-border)]">
      <div className="flex items-center justify-between bg-[var(--surface-block)] px-2 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="select-none text-[10px] text-[var(--content-muted)]"
            aria-label={collapsed ? "Expand system" : "Collapse system"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span className="mono text-[11px] uppercase tracking-wider text-[var(--content-muted)]">system</span>
          {hasCacheControl ?
            <span className="mono text-[11px] text-[var(--signal-warn)]">cached</span>
          : null}
          <RewriteBadge kind={rewriteKind} />
        </div>
        {hasRewrite && !collapsed ?
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => changeMode("original")}
              className={modeClass(mode === "original")}
            >
              Original
            </button>
            <button
              type="button"
              onClick={() => changeMode("rewritten")}
              className={modeClass(mode === "rewritten")}
            >
              Rewritten
            </button>
            <button
              type="button"
              onClick={() => changeMode("diff")}
              className={modeClass(mode === "diff")}
            >
              Diff
            </button>
          </div>
        : null}
      </div>

      {collapsed ? null : (
        <div className="px-2 py-1.5">
          <SystemBody
            mode={mode}
            hasRewrite={hasRewrite}
            originalBlocks={originalBlocks}
            rewrittenBlocks={rewrittenBlocks}
            originalText={originalText}
            rewrittenText={rewrittenText}
            anchorPrefix={anchorPrefix}
          />
        </div>
      )}
    </div>
  )
}
