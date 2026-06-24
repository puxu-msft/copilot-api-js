import type { MessageContent } from "@/lib/content/types"

import { MessageBlock } from "@/components/detail/MessageBlock"

interface ConversationViewProps {
  messages: Array<MessageContent>
  /** When present, each message/block gets a DOM anchor id (`${anchorPrefix}-msg-${i}[-blk-${j}]`). */
  anchorPrefix?: string
}

export function ConversationView({ messages, anchorPrefix }: ConversationViewProps) {
  if (messages.length === 0) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无消息</div>
  return (
    <div className="flex flex-col">
      {messages.map((m, i) => (
        <MessageBlock
          key={i}
          message={m}
          anchorPrefix={anchorPrefix}
          messageIndex={i}
        />
      ))}
    </div>
  )
}
