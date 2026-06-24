import type { MessageContent } from "@/lib/content/types"
import type { RewriteMark } from "@/lib/diff/block-diff"

import { MessageBlock } from "@/components/detail/MessageBlock"

interface ConversationViewProps {
  messages: Array<MessageContent>
  /** When present, each message/block gets a DOM anchor id (`${anchorPrefix}-msg-${i}[-blk-${j}]`). */
  anchorPrefix?: string
  /** Optional per-message rewrite markers (index-aligned with `messages`); `undefined` entries render unmarked. */
  marks?: Array<RewriteMark | undefined>
}

export function ConversationView({ messages, anchorPrefix, marks }: ConversationViewProps) {
  if (messages.length === 0) return <div className="mono p-2 text-[13px] text-[var(--color-muted)]">无消息</div>
  return (
    <div className="flex flex-col">
      {messages.map((m, i) => (
        <MessageBlock
          key={i}
          message={m}
          anchorPrefix={anchorPrefix}
          messageIndex={i}
          mark={marks?.[i]}
        />
      ))}
    </div>
  )
}
