import type { MessageContent } from "@/lib/content/types"
import type { RewriteMark } from "@/lib/diff/block-diff"

import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { normalizeToContentBlocks } from "@/lib/content/normalize"

const ROLE_COLOR: Record<string, string> = {
  user: "var(--color-primary)",
  assistant: "#9ad",
  system: "var(--color-muted)",
  tool: "#4a6a4a",
}

/** Visual vocabulary for the inbound→effective rewrite distinction: badge text, badge/accent color. */
const MARK_META: Record<RewriteMark, { label: string; color: string }> = {
  modified: { label: "rewritten", color: "var(--color-warn)" },
  added: { label: "added", color: "var(--color-ok)" },
  removed: { label: "removed", color: "var(--color-fail)" },
}

interface MessageBlockProps {
  message: MessageContent
  /** When paired with `messageIndex`, the outer wrapper gets id `${anchorPrefix}-msg-${messageIndex}`. */
  anchorPrefix?: string
  messageIndex?: number
  /** Inbound→effective rewrite marker. When set, the block gets a colored left-accent border + a badge in the role row. */
  mark?: RewriteMark
}

export function MessageBlock({ message, anchorPrefix, messageIndex, mark }: MessageBlockProps) {
  const blocks = normalizeToContentBlocks(message)
  const anchored = anchorPrefix !== undefined && messageIndex !== undefined
  const markMeta = mark !== undefined ? MARK_META[mark] : undefined
  return (
    <div
      id={anchored ? `${anchorPrefix}-msg-${messageIndex}` : undefined}
      className="border-b border-[#1e1e24] py-1.5"
      style={markMeta ? { borderLeft: `2px solid ${markMeta.color}`, paddingLeft: "0.5rem" } : undefined}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="mono text-[11px] uppercase tracking-wider"
          style={{ color: ROLE_COLOR[message.role] ?? "#888" }}
        >
          {message.role}
        </span>
        {markMeta ?
          <span
            className="mono border px-1 text-[10px] uppercase tracking-wider"
            style={{ color: markMeta.color, borderColor: markMeta.color }}
          >
            {markMeta.label}
          </span>
        : null}
      </div>
      <ContentRenderer
        blocks={blocks}
        anchorPrefix={anchorPrefix}
        messageIndex={messageIndex}
      />
    </div>
  )
}
