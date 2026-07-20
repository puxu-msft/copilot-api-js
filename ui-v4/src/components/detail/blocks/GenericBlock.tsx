import type { ContentBlock } from "@/lib/content/types"

import { RawJsonView } from "@/components/common/RawJsonView"

export function GenericBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="mono border-l-2 border-[var(--surface-block-border)] bg-[var(--surface-block)] px-2 py-1 text-[13px] text-[var(--content-dim)]">
      <div className="text-[11px] uppercase tracking-wider">{block.type}</div>
      <RawJsonView value={block} />
    </div>
  )
}
