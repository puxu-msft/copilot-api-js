import type {
  //
  ContentBlock,
  MessageContent,
} from "@/lib/content/types"
import type { SystemBlock } from "@/types"

import {
  //
  blockAnchorId,
  messageAnchorId,
  systemBlockAnchorId,
} from "@/lib/content/anchors"
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

/**
 * Short label for a single content block (block-type aware). `toolNames` maps
 * every tool_use `id` → tool `name` so a `tool_result` can name the tool it
 * answers (results carry only a `tool_use_id`; unresolved ones stay bare).
 */
export function blockLabel(block: ContentBlock, toolNames?: Map<string, string>): string {
  if (isTextBlock(block)) {
    return `text: ${truncateShort(collapseWhitespace(block.text))}`
  }
  if (isToolUseBlock(block)) {
    return `tool_use: ${block.name}`
  }
  if (isToolResultBlock(block)) {
    const name = block.tool_use_id ? toolNames?.get(block.tool_use_id) : undefined
    return name ? `tool_result: ${name}` : "tool_result"
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
 * Map every tool_use `id` → its tool `name`, scanning the whole conversation.
 * A `tool_result`'s matching call may live in an earlier message, so this is
 * built once over all messages before labeling any single one.
 */
function collectToolUseNames(messages: Array<MessageContent>): Map<string, string> {
  // A later duplicate id wins (last write); real conversations have unique tool ids.
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const block of normalizeToContentBlocks(message)) {
      // Guard id/name at runtime even though the SDK types mark them required —
      // stored history payloads can be malformed (mirrors buildToolPairing).
      if (isToolUseBlock(block) && block.id && block.name) {
        names.set(block.id, block.name)
      }
    }
  }
  return names
}

/** Message-row label: text preview if any, else a tool_result count, else the bare role. */
function messageNodeLabel(role: string, snippet: string, toolResultCount: number): string {
  if (snippet.length > 0) return `${role}: ${snippet}`
  if (toolResultCount > 0) return `${role}: ${toolResultCount} tool_result${toolResultCount === 1 ? "" : "s"}`
  return role
}

/**
 * Build the TOC tree for a list of messages.
 *
 * Anchor id scheme lives in the shared {@link blockAnchorId} / {@link messageAnchorId} (single
 * source of truth with the renderer + tool-pairing):
 *   - message i: `${anchorPrefix}-msg-${i}`
 *   - block j of message i: `${anchorPrefix}-msg-${i}-blk-${j}`
 *
 * Blocks are derived via `normalizeToContentBlocks` so the block indexing
 * matches what the renderer produces (it renders the SAME normalized blocks).
 * A message that normalizes to 0 blocks omits `children`.
 */
export function buildMessageTocNodes(messages: Array<MessageContent>, anchorPrefix: string): Array<TocNode> {
  const toolNames = collectToolUseNames(messages)
  return messages.map((message, i) => {
    const blocks = normalizeToContentBlocks(message)
    const children = blocks.map((block, j) => ({
      label: blockLabel(block, toolNames),
      anchorId: blockAnchorId(anchorPrefix, i, j),
      kind: block.type,
    }))

    const snippet = messagePreview(message)
    const toolResultCount = blocks.filter((b) => isToolResultBlock(b)).length
    const node: TocNode = {
      label: messageNodeLabel(message.role, snippet, toolResultCount),
      anchorId: messageAnchorId(anchorPrefix, i),
      kind: message.role,
    }
    return children.length > 0 ? { ...node, children } : node
  })
}

/**
 * Build a flat TOC for a system payload's blocks — one node per block, no nesting
 * (system has no message layer). Anchor scheme is {@link systemBlockAnchorId}
 * (`${anchorPrefix}-blk-${i}`), matching the ids `SystemMessage` attaches to each
 * rendered block. Labels lead with `text[i]` to mirror the block labels shown in
 * the content pane. Callers gate on `blocks.length > 1` (single-block/string
 * systems need no navigation).
 */
export function buildSystemTocNodes(blocks: Array<SystemBlock>, anchorPrefix: string): Array<TocNode> {
  return blocks.map((block, i) => ({
    label: `text[${i}]: ${truncateShort(collapseWhitespace(block.text))}`,
    anchorId: systemBlockAnchorId(anchorPrefix, i),
    kind: "system",
  }))
}
