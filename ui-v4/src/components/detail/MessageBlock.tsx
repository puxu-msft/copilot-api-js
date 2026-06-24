import type { MessageContent } from "@/lib/content/types"

import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { normalizeToContentBlocks } from "@/lib/content/normalize"

const ROLE_COLOR: Record<string, string> = {
  user: "var(--color-primary)",
  assistant: "#9ad",
  system: "var(--color-muted)",
  tool: "#4a6a4a",
}

interface MessageBlockProps {
  message: MessageContent
  /** When paired with `messageIndex`, the outer wrapper gets id `${anchorPrefix}-msg-${messageIndex}`. */
  anchorPrefix?: string
  messageIndex?: number
}

export function MessageBlock({ message, anchorPrefix, messageIndex }: MessageBlockProps) {
  const blocks = normalizeToContentBlocks(message)
  const anchored = anchorPrefix !== undefined && messageIndex !== undefined
  return (
    <div
      id={anchored ? `${anchorPrefix}-msg-${messageIndex}` : undefined}
      className="border-b border-[#1e1e24] py-1.5"
    >
      <div
        className="mono mb-1 text-[11px] uppercase tracking-wider"
        style={{ color: ROLE_COLOR[message.role] ?? "#888" }}
      >
        {message.role}
      </div>
      <ContentRenderer
        blocks={blocks}
        anchorPrefix={anchorPrefix}
        messageIndex={messageIndex}
      />
    </div>
  )
}
