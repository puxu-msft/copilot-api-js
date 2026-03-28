import consola from "consola"

import type { MessageParam } from "~/types/api/anthropic"

import { isServerToolResultBlock, isToolResultBlock } from "~/types/api/anthropic"

import { isImmutableThinkingAssistantMessage } from "../thinking-immutability"

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
 * Ensure Anthropic messages start with a user message.
 * Drops leading non-user messages (e.g., orphaned assistant messages after truncation).
 */
export function ensureAnthropicStartsWithUser(messages: Array<MessageParam>): Array<MessageParam> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[AutoTruncate:Anthropic] Skipped ${startIndex} leading non-user messages`)
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

    if (isImmutableThinkingAssistantMessage(msg)) {
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
