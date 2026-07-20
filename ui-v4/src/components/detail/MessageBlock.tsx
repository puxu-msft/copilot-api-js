import type { MessageContent } from "@/lib/content/types"
import type { RewriteMark } from "@/lib/diff/block-diff"

import { ContentRenderer } from "@/components/detail/ContentRenderer"
import { JsonModalButton } from "@/components/detail/JsonModalButton"
import { messageAnchorId } from "@/lib/content/anchors"
import { normalizeToContentBlocks } from "@/lib/content/normalize"

const ROLE_COLOR: Record<string, string> = {
  user: "var(--content-accent)",
  assistant: "var(--content-role-assistant)",
  system: "var(--content-muted)",
  tool: "var(--content-tool-dim)",
}

/** Visual vocabulary for the inbound→effective rewrite distinction: badge text, badge/accent color. */
const MARK_META: Record<RewriteMark, { label: string; color: string }> = {
  modified: { label: "rewritten", color: "var(--signal-warn)" },
  added: { label: "added", color: "var(--content-add)" },
  removed: { label: "removed", color: "var(--content-del)" },
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
      id={anchored ? messageAnchorId(anchorPrefix, messageIndex) : undefined}
      className="group border-b border-[var(--surface-border-subtle)] py-1.5"
      style={markMeta ? { borderLeft: `2px solid ${markMeta.color}`, paddingLeft: "0.5rem" } : undefined}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="mono text-[11px] uppercase tracking-wider"
          style={{ color: ROLE_COLOR[message.role] ?? "var(--content-dim)" }}
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
        <JsonModalButton
          value={message}
          label="View message JSON"
          className="mono ml-auto border border-[var(--surface-border)] px-1 text-[11px] leading-tight text-[var(--content-muted)] opacity-0 transition-opacity hover:text-[var(--content-accent)] focus:opacity-100 group-hover:opacity-100"
        />
      </div>
      <ContentRenderer
        blocks={blocks}
        anchorPrefix={anchorPrefix}
        messageIndex={messageIndex}
      />
    </div>
  )
}
