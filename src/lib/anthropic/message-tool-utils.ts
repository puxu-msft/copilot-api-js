import consola from "consola"

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  isServerToolResultBlock,
  isToolResultBlock,
} from "~/types/api/anthropic"

/**
 * Get tool_use IDs from an Anthropic assistant message.
 */
export function getAnthropicToolUseIds(msg: MessageParam): Array<string> {
  if (msg.role !== "assistant") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if ((block.type === "tool_use" || block.type === "server_tool_use") && block.id) {
      ids.push(block.id)
    }
  }
  return ids
}

/**
 * Get tool_result IDs from an Anthropic message.
 * Checks both user messages (regular tool_result) and assistant messages
 * (server tool results like tool_search_tool_result which appear inline).
 */
export function getAnthropicToolResultIds(msg: MessageParam): Array<string> {
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (isToolResultBlock(block)) {
      ids.push(block.tool_use_id)
    } else if (isServerToolResultBlock(block)) {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Whether a message is a LEGAL first message for an Anthropic request.
 *
 * Anthropic requires `messages[0]` to be a user message, and rejects a user
 * message whose content is only tool_result blocks at index 0 (a "tool result
 * turn" with no preceding tool_use — its tool_use was truncated away, so the
 * tool_result is orphaned). Truncation can land the preserve boundary on such a
 * turn, so callers skip leading messages until this returns true.
 *
 * Legal: a user message with string content, or array content containing at
 * least one non-tool_result block (text / image / …). A mixed
 * user[tool_result, text] is legal (kept) — only a PURE tool_result turn is not.
 */
export function isLegalLeadingUserMessage(msg: MessageParam): boolean {
  if (msg.role !== "user") return false
  if (typeof msg.content === "string") return true
  if (msg.content.length === 0) return false
  // Legal iff at least one block is NOT a tool_result (regular or server).
  return msg.content.some((block) => !isToolResultBlock(block) && !isServerToolResultBlock(block))
}

/**
 * Ensure Anthropic messages start with a LEGAL first user message.
 * Drops leading messages that can't be `messages[0]`: non-user messages
 * (e.g. orphaned assistant after truncation) AND pure-tool_result user turns
 * (orphaned tool results whose tool_use was truncated away).
 */
export function ensureAnthropicStartsWithUser(messages: Array<MessageParam>): Array<MessageParam> {
  let startIndex = 0
  while (startIndex < messages.length && !isLegalLeadingUserMessage(messages[startIndex])) {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[AutoTruncate:Anthropic] Skipped ${startIndex} leading non-startable messages`)
  }

  return messages.slice(startIndex)
}

/**
 * Filter orphaned tool_result blocks (no matching tool_use).
 */
export function filterAnthropicOrphanedToolResults(messages: Array<MessageParam>): Array<MessageParam> {
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolUseIds(msg)) {
      toolUseIds.add(id)
    }
  }

  let removed = 0
  const result: Array<MessageParam> = []

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    const filtered = msg.content.filter((block) => {
      if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
        removed++
        return false
      }
      if (isServerToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
        removed++
        return false
      }
      return true
    })

    if (filtered.length === 0) continue
    if (filtered.length === msg.content.length) {
      result.push(msg)
    } else {
      result.push({ ...msg, content: filtered } as MessageParam)
    }
  }

  if (removed > 0) {
    consola.debug(`[AutoTruncate:Anthropic] Filtered ${removed} orphaned tool results`)
  }

  return result
}

/**
 * Filter orphaned tool_use blocks (no matching tool_result).
 */
export function filterAnthropicOrphanedToolUse(messages: Array<MessageParam>): Array<MessageParam> {
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolResultIds(msg)) {
      toolResultIds.add(id)
    }
  }

  let removed = 0
  const result: Array<MessageParam> = []

  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    const survivingIds = new Set<string>()
    for (const block of msg.content) {
      if ((block.type === "tool_use" || block.type === "server_tool_use") && toolResultIds.has(block.id)) {
        survivingIds.add(block.id)
      }
    }

    const filtered = msg.content.filter((block) => {
      if ((block.type === "tool_use" || block.type === "server_tool_use") && !toolResultIds.has(block.id)) {
        removed++
        return false
      }
      if (isServerToolResultBlock(block) && !survivingIds.has(block.tool_use_id)) {
        removed++
        return false
      }
      return true
    })

    if (filtered.length === 0) continue
    if (filtered.length === msg.content.length) {
      result.push(msg)
    } else {
      result.push({ ...msg, content: filtered } as MessageParam)
    }
  }

  if (removed > 0) {
    consola.debug(`[AutoTruncate:Anthropic] Filtered ${removed} orphaned tool blocks`)
  }

  return result
}
