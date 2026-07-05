import type { ContentBlock } from "@/lib/content/types"

import { BlockChrome } from "@/components/detail/BlockChrome"
import { GenericBlock } from "@/components/detail/blocks/GenericBlock"
import { ImageBlock } from "@/components/detail/blocks/ImageBlock"
import { TextBlock } from "@/components/detail/blocks/TextBlock"
import { ThinkingBlock } from "@/components/detail/blocks/ThinkingBlock"
import { ToolResultBlock } from "@/components/detail/blocks/ToolResultBlock"
import { ToolUseBlock } from "@/components/detail/blocks/ToolUseBlock"
import { ErrorBoundary } from "@/components/detail/ErrorBoundary"
import {
  //
  isImageBlock,
  isRedactedThinkingBlock,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
} from "@/lib/content/normalize"

function renderBlock(block: ContentBlock) {
  if (isTextBlock(block)) return <TextBlock block={block} />
  if (isThinkingBlock(block)) return <ThinkingBlock block={block} />
  if (isRedactedThinkingBlock(block))
    return (
      <ThinkingBlock
        block={block}
        redacted
      />
    )
  if (isToolUseBlock(block)) return <ToolUseBlock block={block} />
  if (isToolResultBlock(block)) return <ToolResultBlock block={block} />
  if (isImageBlock(block)) return <ImageBlock block={block} />
  return <GenericBlock block={block} />
}

interface ContentRendererProps {
  blocks: Array<ContentBlock>
  /** When paired with `messageIndex`, each block is wrapped in a div with id `${anchorPrefix}-msg-${messageIndex}-blk-${i}`. */
  anchorPrefix?: string
  messageIndex?: number
}

/** 纯分发器 —— 按 block.type 选组件(spec §9,8 类 + generic),每块包 ErrorBoundary。锚定时(anchorPrefix+messageIndex)才额外包 id 锚点。BlockChrome 统一给每块加 raw-JSON 查看入口(hover `{ }` → modal)。 */
export function ContentRenderer({ blocks, anchorPrefix, messageIndex }: ContentRendererProps) {
  const anchored = anchorPrefix !== undefined && messageIndex !== undefined
  return (
    <div className="flex flex-col gap-1">
      {blocks.map((block, i) => (
        <BlockChrome
          key={i}
          block={block}
          id={anchored ? `${anchorPrefix}-msg-${messageIndex}-blk-${i}` : undefined}
        >
          <ErrorBoundary label={block.type}>{renderBlock(block)}</ErrorBoundary>
        </BlockChrome>
      ))}
    </div>
  )
}
