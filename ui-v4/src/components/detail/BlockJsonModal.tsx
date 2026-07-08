import { RawJsonView } from "@/components/common/RawJsonView"
import { Modal } from "@/components/shared/Modal"

/** Best-effort label off an arbitrary JSON value for the modal title: `type` (content block)
 *  or `role` (a whole message object), falling back to a generic `"block"`. */
function blockType(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const v = value as { type?: unknown; role?: unknown }
    if (typeof v.type === "string") return v.type
    if (typeof v.role === "string") return v.role
  }
  return "block"
}

interface BlockJsonModalProps {
  value: unknown
  onClose: () => void
}

/**
 * Modal that shows one content block's JSON via the shared `<RawJsonView>` (Source /
 * Tree toggle + per-view copy toolbars). Pure presentation — the caller owns the block
 * object; this only stringifies / walks it. The value is the block *as rendered* (post
 * `normalizeToContentBlocks`): for Anthropic-format content that is the verbatim wire
 * object; for OpenAI-format content it is the canonicalized block. The true unmodified
 * request wire bytes remain available via ConvoSegment's "Raw body" toggle.
 */
export function BlockJsonModal({ value, onClose }: BlockJsonModalProps) {
  return (
    <Modal
      title={`${blockType(value)} JSON`}
      onClose={onClose}
    >
      <RawJsonView value={value} />
    </Modal>
  )
}
