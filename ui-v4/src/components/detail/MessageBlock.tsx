import type { MessageContent } from "@/lib/content/types"

import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { normalizeToContentBlocks } from "@/lib/content/normalize"

const ROLE_COLOR: Record<string, string> = {
  user: "var(--color-primary)",
  assistant: "#9ad",
  system: "var(--color-muted)",
  tool: "#4a6a4a",
}

export function MessageBlock({ message }: { message: MessageContent }) {
  const blocks = normalizeToContentBlocks(message)
  return (
    <div className="border-b border-[#1e1e24] py-1.5">
      <div
        className="mono mb-1 text-[11px] uppercase tracking-wider"
        style={{ color: ROLE_COLOR[message.role] ?? "#888" }}
      >
        {message.role}
      </div>
      <ContentRenderer blocks={blocks} />
    </div>
  )
}
