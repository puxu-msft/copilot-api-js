import type { ReactNode } from "react"

import type { ContentBlock } from "@/lib/content/types"

import { JsonModalButton } from "@/components/detail/JsonModalButton"

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
 * per-block-component duplication. The button + modal wiring is delegated to the shared
 * {@link JsonModalButton}; BlockChrome only owns the positioning (absolute hover corner).
 */
export function BlockChrome({ block, id, children }: BlockChromeProps) {
  return (
    <div
      id={id}
      className="group relative"
    >
      <JsonModalButton
        value={block}
        label="View block JSON"
        className="mono absolute right-1 top-1 z-10 border border-[var(--color-border)] bg-[var(--color-surface)] px-1 text-[11px] leading-tight text-[var(--color-muted)] opacity-0 transition-opacity hover:text-[var(--color-primary)] focus:opacity-100 group-hover:opacity-100"
      />
      {children}
    </div>
  )
}
