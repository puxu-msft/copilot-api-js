import { useState } from "react"

import type { SystemBlock } from "@/types"

import { UnifiedLineDiff } from "@/components/detail/diff/UnifiedLineDiff"
import { LineNumberedText } from "@/components/detail/LineNumberedText"
import { diffLinesRich } from "@/lib/diff/block-diff"

type SystemValue = string | Array<SystemBlock>
type ViewMode = "original" | "rewritten" | "diff"

interface SystemMessageProps {
  system: SystemValue
  rewrittenSystem?: SystemValue | null
}

function systemToText(system: SystemValue): string {
  if (typeof system === "string") return system
  return system.map((b) => b.text).join("\n")
}

function toBlocks(system: SystemValue): Array<SystemBlock> {
  if (typeof system === "string") return [{ type: "text", text: system }]
  return system
}

/** One block of a system payload, with `text[i]` + `[cache: type]` labels when relevant. */
function SystemBlocksBody({ blocks }: { blocks: Array<SystemBlock> }) {
  const multiple = blocks.length > 1
  return (
    <div>
      {blocks.map((block, i) => (
        <div
          key={i}
          className={multiple ? "mb-2 border border-[var(--color-border)] p-1.5 last:mb-0" : ""}
        >
          {multiple || block.cache_control ?
            <div className="mono mb-1 flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
              {multiple ?
                <span>text[{i}]</span>
              : null}
              {block.cache_control ?
                <span className="italic text-[var(--color-warn)]">[cache: {block.cache_control.type}]</span>
              : null}
            </div>
          : null}
          <div className="text-[var(--color-text)]">
            <LineNumberedText text={block.text} />
          </div>
        </div>
      ))}
    </div>
  )
}

const TOGGLE_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

function modeClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`
}

/** `modified` when content actually changed, else `rewritten` when a rewrite exists. */
function RewriteBadge({ hasRewrite, contentDiffers }: { hasRewrite: boolean; contentDiffers: boolean }) {
  if (contentDiffers) return <span className="mono text-[11px] text-[var(--color-warn)]">modified</span>
  if (hasRewrite) return <span className="mono text-[11px] text-[var(--color-muted)]">rewritten</span>
  return null
}

interface SystemBodyProps {
  mode: ViewMode
  hasRewrite: boolean
  originalBlocks: Array<SystemBlock>
  rewrittenBlocks: Array<SystemBlock>
  originalText: string
  rewrittenText: string
}

function SystemBody({ mode, hasRewrite, originalBlocks, rewrittenBlocks, originalText, rewrittenText }: SystemBodyProps) {
  if (!hasRewrite || mode === "original") return <SystemBlocksBody blocks={originalBlocks} />
  if (mode === "rewritten") return <SystemBlocksBody blocks={rewrittenBlocks} />
  return (
    <>
      {originalBlocks.length !== rewrittenBlocks.length ?
        <div className="mono mb-1 text-[11px] font-semibold text-[var(--color-warn)]">
          Block count changed: {originalBlocks.length} → {rewrittenBlocks.length}
        </div>
      : null}
      <UnifiedLineDiff rows={diffLinesRich(originalText, rewrittenText)} />
    </>
  )
}

export function SystemMessage({ system, rewrittenSystem }: SystemMessageProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mode, setMode] = useState<ViewMode>("original")

  const originalText = systemToText(system)
  const rewrittenText = rewrittenSystem ? systemToText(rewrittenSystem) : ""
  const hasRewrite = Boolean(rewrittenSystem)
  const contentDiffers = hasRewrite && originalText !== rewrittenText

  const originalBlocks = toBlocks(system)
  const rewrittenBlocks = rewrittenSystem ? toBlocks(rewrittenSystem) : []
  const hasCacheControl = originalBlocks.some((b) => b.cache_control)

  return (
    <div className="mb-2 border border-[var(--color-border)]">
      <div className="flex items-center justify-between bg-[#161616] px-2 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="select-none text-[10px] text-[var(--color-muted)]"
            aria-label={collapsed ? "Expand system" : "Collapse system"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span className="mono text-[11px] uppercase tracking-wider text-[var(--color-muted)]">system</span>
          {hasCacheControl ?
            <span className="mono text-[11px] text-[var(--color-warn)]">cached</span>
          : null}
          <RewriteBadge
            hasRewrite={hasRewrite}
            contentDiffers={contentDiffers}
          />
        </div>
        {hasRewrite && !collapsed ?
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMode("original")}
              className={modeClass(mode === "original")}
            >
              Original
            </button>
            <button
              type="button"
              onClick={() => setMode("rewritten")}
              className={modeClass(mode === "rewritten")}
            >
              Rewritten
            </button>
            <button
              type="button"
              onClick={() => setMode("diff")}
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
          />
        </div>
      )}
    </div>
  )
}
