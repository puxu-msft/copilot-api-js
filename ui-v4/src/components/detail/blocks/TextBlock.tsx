import type { TextContentBlock } from "@/lib/content/types"

import { LineNumberedText } from "@/components/detail/LineNumberedText"

export function TextBlock({ block }: { block: TextContentBlock }) {
  return (
    <div className="text-[#cdc]">
      <LineNumberedText text={block.text} />
    </div>
  )
}
