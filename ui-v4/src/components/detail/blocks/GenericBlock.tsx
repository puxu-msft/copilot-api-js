import type { ContentBlock } from "@/lib/content/types"

import { CodeBlock } from "@/components/detail/CodeBlock"

export function GenericBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="mono border-l-2 border-[#444] bg-[#161616] px-2 py-1 text-[13px] text-[#888]">
      <div className="text-[11px] uppercase tracking-wider">{block.type}</div>
      <CodeBlock
        code={JSON.stringify(block, null, 2)}
        lang="json"
      />
    </div>
  )
}
