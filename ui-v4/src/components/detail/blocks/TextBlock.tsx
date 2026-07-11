import type { TextContentBlock } from "@/lib/content/types"

import { LineNumberedText } from "@/components/detail/LineNumberedText"

export function TextBlock({ block }: { block: TextContentBlock }) {
  return (
    <div className="border-l-2 border-[var(--surface-text-block-border)] bg-[var(--surface-text-block)] px-2 py-1">
      <div className="mono text-[11px] uppercase tracking-wider text-[var(--content-muted)]">text</div>
      <div className="text-[var(--content-text-block)]">
        <LineNumberedText text={block.text} />
      </div>
    </div>
  )
}
