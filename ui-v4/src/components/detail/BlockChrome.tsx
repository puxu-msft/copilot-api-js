import type { ReactNode } from "react"

import { useState } from "react"

import type { ContentBlock } from "@/lib/content/types"

import { BlockJsonModal } from "@/components/detail/BlockJsonModal"

interface BlockChromeProps {
  /** The content block *as rendered* — shown when the JSON affordance is opened. */
  block: ContentBlock
  /** Optional DOM anchor id carried on the container (for in-request scroll targeting). */
  id?: string
  children: ReactNode
}

/**
 * Per-block wrapper adding a hover-revealed `{ }` affordance that opens the block's JSON
 * in a modal. Wrapping at the ContentRenderer level gives every content block (request,
 * response, nested tool_result) this affordance from a single insertion point — no
 * per-block-component duplication.
 */
export function BlockChrome({ block, id, children }: BlockChromeProps) {
  const [open, setOpen] = useState(false)
  return (
    <div
      id={id}
      className="group relative"
    >
      <button
        type="button"
        aria-label="View block JSON"
        title="View block JSON"
        onClick={(e) => {
          // Don't let the affordance toggle any (future) interactive block content beneath it.
          e.stopPropagation()
          setOpen(true)
        }}
        className="mono absolute right-1 top-1 z-10 border border-[var(--color-border)] bg-[var(--color-surface)] px-1 text-[11px] leading-tight text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-primary)] focus:opacity-100 group-hover:opacity-100"
      >
        {"{ }"}
      </button>
      {children}
      {open ?
        <BlockJsonModal
          value={block}
          onClose={() => setOpen(false)}
        />
      : null}
    </div>
  )
}
