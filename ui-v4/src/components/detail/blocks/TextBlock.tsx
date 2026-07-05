import type { TextContentBlock } from "@/lib/content/types"

import { LineNumberedText } from "@/components/detail/LineNumberedText"

export function TextBlock({ block }: { block: TextContentBlock }) {
  return (
    <div className="border-l-2 border-[#3a4656] bg-[#12161c] px-2 py-1">
      <div className="mono text-[11px] uppercase tracking-wider text-[var(--color-muted)]">text</div>
      <div className="text-[#cdc]">
        <LineNumberedText text={block.text} />
      </div>
    </div>
  )
}
