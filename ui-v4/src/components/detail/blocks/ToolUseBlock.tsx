import type { ToolUseContentBlock } from "@/lib/content/types"

export function ToolUseBlock({ block }: { block: ToolUseContentBlock }) {
  return (
    <div className="mono border-l-2 border-[var(--color-primary)] bg-[#1f1a12] px-2 py-1 text-[13px]">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">tool_use</div>
      <div className="text-[var(--color-primary)]">{block.name}</div>
      <pre className="whitespace-pre-wrap break-all text-[13px] text-[#aaa]">{JSON.stringify(block.input, null, 2)}</pre>
    </div>
  )
}
