import type { MessageContent } from "@/lib/content/types"

import { blockAnchorId } from "@/lib/content/anchors"
import {
  //
  isToolResultBlock,
  isToolUseBlock,
  normalizeToContentBlocks,
} from "@/lib/content/normalize"

/** DOM anchors of a tool call and its result, keyed by the shared tool id. Either side may be absent. */
export interface ToolPair {
  /** Anchor of the `tool_use` block (the call). */
  useAnchor?: string
  /** Anchor of the `tool_result` block (the outcome). */
  resultAnchor?: string
}

/**
 * Walk a conversation and pair each `tool_use` (by `id`) with its `tool_result` (by `tool_use_id`),
 * recording each side's DOM anchor. Anchors come from the shared {@link blockAnchorId} over the SAME
 * normalized block list the renderer uses, so the returned ids resolve via `document.getElementById`
 * for scroll-to-counterpart navigation.
 */
export function buildToolPairing(messages: Array<MessageContent>, anchorPrefix: string): Map<string, ToolPair> {
  const pairing = new Map<string, ToolPair>()
  const upsert = (id: string, patch: ToolPair) => {
    pairing.set(id, { ...pairing.get(id), ...patch })
  }

  for (const [messageIndex, message] of messages.entries()) {
    const blocks = normalizeToContentBlocks(message)
    for (const [blockIndex, block] of blocks.entries()) {
      const anchor = blockAnchorId(anchorPrefix, messageIndex, blockIndex)
      if (isToolUseBlock(block) && block.id) upsert(block.id, { useAnchor: anchor })
      else if (isToolResultBlock(block) && block.tool_use_id) upsert(block.tool_use_id, { resultAnchor: anchor })
    }
  }

  return pairing
}
