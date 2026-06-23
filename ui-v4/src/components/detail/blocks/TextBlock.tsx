import type { TextContentBlock } from "@/lib/content/types"

export function TextBlock({ block }: { block: TextContentBlock }) {
  return <div className="mono whitespace-pre-wrap break-words text-[14px] text-[#cdc]">{block.text}</div>
}
