import type {
  //
  ContentBlock,
  ToolResultContentBlock,
} from "@/lib/content/types"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { ToolJumpButton } from "@/components/detail/ToolJumpButton"
import { useToolPairing } from "@/components/detail/ToolPairingContext"

type ToolResultContent = ToolResultContentBlock["content"]
type ToolResultBlockArray = Extract<ToolResultContent, Array<unknown>>

/** content 是非空的 content-block 数组(每个元素是带 `type` 的对象)时,走递归渲染。 */
function isContentBlockArray(content: ToolResultContent): content is ToolResultBlockArray {
  return Array.isArray(content) && content.length > 0
}

function renderContent(content: ToolResultContent) {
  if (typeof content === "string") return <pre className="whitespace-pre-wrap break-all text-[#9a9]">{content}</pre>
  if (isContentBlockArray(content)) return <ContentRenderer blocks={content as Array<ContentBlock>} />
  return (
    <CodeBlock
      code={JSON.stringify(content, null, 2)}
      lang="json"
    />
  )
}

export function ToolResultBlock({ block }: { block: ToolResultContentBlock }) {
  const ctx = useToolPairing()
  const useAnchor = ctx?.pairing.get(block.tool_use_id)?.useAnchor
  return (
    <div className="mono border-l-2 border-[#4a6a4a] bg-[#141a14] px-2 py-1 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">tool_result · {block.tool_use_id}</div>
        {ctx && useAnchor ?
          <ToolJumpButton
            label="↑ call"
            ariaLabel="Jump to tool call"
            onJump={() => ctx.scrollTo(useAnchor)}
          />
        : null}
      </div>
      {renderContent(block.content)}
    </div>
  )
}
