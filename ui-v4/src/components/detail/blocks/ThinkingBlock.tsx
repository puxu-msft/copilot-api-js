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
    <div className="mono border-l-2 border-[var(--content-thinking-dim)] bg-[var(--surface-thinking)] px-2 py-1 text-[13px] text-[var(--content-thinking)]">
      <div className="text-[11px] uppercase tracking-wider text-[var(--content-thinking-dim)]">thinking{redacted ? " (redacted)" : ""}</div>
      <div className="whitespace-pre-wrap break-words">{text}</div>
    </div>
  )
}
