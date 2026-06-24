import type {
  //
  ContentBlock,
  MessageContent,
} from "@/lib/content/types"

import {
  //
  isImageBlock,
  isRedactedThinkingBlock,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  normalizeToContentBlocks,
} from "@/lib/content/normalize"

/**
 * A single node in the table-of-contents tree.
 *
 * Built purely from message content — no React, no DOM. The presentational
 * `DetailTocTree` renders these, and Task 3's renderer attaches the matching
 * `anchorId`s to real DOM elements for scroll-to navigation.
 */
export interface TocNode {
  /** Human-readable label shown in the tree row. */
  label: string
  /** DOM anchor id (see scheme below) — CONTRACT with the renderer. */
  anchorId: string
  /** message `role` (parent nodes) or block `type` (child nodes). */
  kind: string
  children?: Array<TocNode>
}

/** Max characters before a message preview/label is truncated with an ellipsis. */
const PREVIEW_MAX = 32

/** Shorter cap for block-text labels, so the leading `text:` type stays visible. */
const BLOCK_TEXT_MAX = 24

/** Collapse all runs of whitespace (incl. newlines) to single spaces and trim. */
function collapseWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, " ").trim()
}

/** Truncate to `PREVIEW_MAX` chars, appending `…` when the source was longer. */
function truncate(s: string): string {
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s
}

/** Truncate to `BLOCK_TEXT_MAX` chars, appending `…` when the source was longer. */
function truncateShort(s: string): string {
  return s.length > BLOCK_TEXT_MAX ? `${s.slice(0, BLOCK_TEXT_MAX)}…` : s
}

/**
 * Short, single-line text projection of a message for a tree label.
 *
 * String content is used verbatim; block content joins the text of any text
 * blocks. A message with no text (e.g. tool-only) projects to an empty string —
 * callers lead the label with `role` and append this snippet only when present.
 */
export function messagePreview(m: MessageContent): string {
  if (typeof m.content === "string") {
    return truncate(collapseWhitespace(m.content))
  }
  if (!Array.isArray(m.content)) {
    return ""
  }

  const text = m.content
    .filter((b) => isTextBlock(b))
    .map((b) => b.text)
    .join(" ")

  return truncate(collapseWhitespace(text))
}

/** Short label for a single content block (block-type aware). */
export function blockLabel(block: ContentBlock): string {
  if (isTextBlock(block)) {
    return `text: ${truncateShort(collapseWhitespace(block.text))}`
  }
  if (isToolUseBlock(block)) {
    return `tool_use: ${block.name}`
  }
  if (isToolResultBlock(block)) {
    return "tool_result"
  }
  if (isRedactedThinkingBlock(block)) {
    return "thinking (redacted)"
  }
  if (isThinkingBlock(block)) {
    return "thinking"
  }
  if (isImageBlock(block)) {
    return "image"
  }
  return block.type
}

/**
 * Build the TOC tree for a list of messages.
 *
 * Anchor id scheme (CONTRACT with Task 3/4's renderer — the renderer attaches
 * DOM elements carrying these exact ids):
 *   - message i: `${anchorPrefix}-msg-${i}`
 *   - block j of message i: `${anchorPrefix}-msg-${i}-blk-${j}`
 *
 * Blocks are derived via `normalizeToContentBlocks` so the block indexing
 * matches what the renderer produces (it renders the SAME normalized blocks).
 * A message that normalizes to 0 blocks omits `children`.
 */
export function buildMessageTocNodes(messages: Array<MessageContent>, anchorPrefix: string): Array<TocNode> {
  return messages.map((message, i) => {
    const blocks = normalizeToContentBlocks(message)
    const children = blocks.map((block, j) => ({
      label: blockLabel(block),
      anchorId: `${anchorPrefix}-msg-${i}-blk-${j}`,
      kind: block.type,
    }))

    const snippet = messagePreview(message)
    const node: TocNode = {
      label: snippet.length > 0 ? `${message.role}: ${snippet}` : message.role,
      anchorId: `${anchorPrefix}-msg-${i}`,
      kind: message.role,
    }
    return children.length > 0 ? { ...node, children } : node
  })
}
