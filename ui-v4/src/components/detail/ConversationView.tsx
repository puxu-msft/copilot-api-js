import type { MessageContent } from "@/lib/content/types"

import { MessageBlock } from "@/components/detail/MessageBlock"

export function ConversationView({ messages }: { messages: Array<MessageContent> }) {
  if (messages.length === 0) return <div className="mono p-2 text-[10px] text-[var(--color-muted)]">无消息</div>
  return (
    <div className="flex flex-col">
      {messages.map((m, i) => (
        <MessageBlock
          key={i}
          message={m}
        />
      ))}
    </div>
  )
}
