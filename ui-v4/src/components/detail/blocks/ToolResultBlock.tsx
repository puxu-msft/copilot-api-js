import type { ToolResultContentBlock } from "@/lib/content/types"

export function ToolResultBlock({ block }: { block: ToolResultContentBlock }) {
  const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)
  return (
    <div className="mono border-l-2 border-[#4a6a4a] bg-[#141a14] px-2 py-1 text-[13px]">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">tool_result · {block.tool_use_id}</div>
      <pre className="whitespace-pre-wrap break-all text-[#9a9]">{text}</pre>
    </div>
  )
}
