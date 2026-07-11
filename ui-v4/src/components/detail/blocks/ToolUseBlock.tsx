import type { ToolUseContentBlock } from "@/lib/content/types"

import { RawJsonView } from "@/components/common/RawJsonView"
import { ToolJumpButton } from "@/components/detail/ToolJumpButton"
import { useToolPairing } from "@/components/detail/ToolPairingContext"

export function ToolUseBlock({ block }: { block: ToolUseContentBlock }) {
  const ctx = useToolPairing()
  const resultAnchor = ctx?.pairing.get(block.id)?.resultAnchor
  return (
    <div className="mono border-l-2 border-[var(--content-accent)] bg-[var(--surface-tool-use)] px-2 py-1 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--content-muted)]">tool_use</div>
        {ctx && resultAnchor ?
          <ToolJumpButton
            label="↓ result"
            ariaLabel="Jump to tool result"
            onJump={() => ctx.scrollTo(resultAnchor)}
          />
        : null}
      </div>
      <div className="text-[var(--content-accent)]">{block.name}</div>
      <RawJsonView value={block.input} />
    </div>
  )
}
