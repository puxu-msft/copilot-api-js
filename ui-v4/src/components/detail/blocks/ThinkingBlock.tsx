import type {
  //
  RedactedThinkingContentBlock,
  ThinkingContentBlock,
} from "@/lib/content/types"

interface ThinkingBlockProps {
  block: RedactedThinkingContentBlock | ThinkingContentBlock
  redacted?: boolean
}

export function ThinkingBlock({ block, redacted }: ThinkingBlockProps) {
  const text = redacted ? "[redacted thinking]" : (block as ThinkingContentBlock).thinking
  return (
    <div className="mono border-l-2 border-[#6a5a8a] bg-[#1a1820] px-2 py-1 text-[10px] text-[#a89ac0]">
      <div className="text-[8px] uppercase tracking-wider text-[#6a5a8a]">thinking{redacted ? " (redacted)" : ""}</div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </div>
  )
}
