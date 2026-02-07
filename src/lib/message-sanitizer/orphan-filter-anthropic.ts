/**
 * Anthropic orphaned tool block filtering.
 *
 * Filters orphaned tool_result and tool_use blocks from Anthropic messages
 * to ensure API compatibility. Orphaned blocks can occur when:
 * - Previous truncation/compaction was interrupted
 * - Client sends malformed message history
 * - Message history was edited externally
 */

import consola from "consola"

import type { AnthropicMessage } from "~/types/api/anthropic"
import { isServerToolResultBlock } from "~/types/api/anthropic"

/**
 * Get tool_use IDs from an Anthropic assistant message.
 */
export function getAnthropicToolUseIds(msg: AnthropicMessage): Array<string> {
  if (msg.role !== "assistant") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_use" || block.type === "server_tool_use") {
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
export function getAnthropicToolResultIds(msg: AnthropicMessage): Array<string> {
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_result" && "tool_use_id" in block) {
      ids.push((block as { tool_use_id: string }).tool_use_id)
    } else if (isServerToolResultBlock(block)) {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Filter orphaned tool_result blocks from Anthropic messages.
 */
export function filterAnthropicOrphanedToolResults(messages: Array<AnthropicMessage>): Array<AnthropicMessage> {
  // Collect all tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolUseIds(msg)) {
      toolUseIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_results from user messages
  const result: Array<AnthropicMessage> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content !== "string") {
      const toolResultIds = getAnthropicToolResultIds(msg)
      const hasOrphanedToolResult = toolResultIds.some((id) => !toolUseIds.has(id))

      if (hasOrphanedToolResult) {
        // Filter out orphaned tool_result blocks
        const filteredContent = msg.content.filter((block) => {
          if (block.type === "tool_result" && !toolUseIds.has(block.tool_use_id)) {
            removedCount++
            return false
          }
          if (isServerToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
            removedCount++
            return false
          }
          return true
        })

        // If all content was tool_results that got removed, skip the message
        if (filteredContent.length === 0) {
          continue
        }

        result.push({ ...msg, content: filteredContent })
        continue
      }
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool_result`)
  }

  return result
}

/**
 * Filter orphaned tool_use blocks from Anthropic messages.
 */
export function filterAnthropicOrphanedToolUse(messages: Array<AnthropicMessage>): Array<AnthropicMessage> {
  // Collect all tool_result IDs
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolResultIds(msg)) {
      toolResultIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_use from assistant messages
  const result: Array<AnthropicMessage> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content !== "string") {
      const msgToolUseIds = getAnthropicToolUseIds(msg)
      const hasOrphanedToolUse = msgToolUseIds.some((id) => !toolResultIds.has(id))

      if (hasOrphanedToolUse) {
        // Filter out orphaned tool_use blocks
        const filteredContent = msg.content.filter((block) => {
          if (block.type === "tool_use" && !toolResultIds.has(block.id)) {
            removedCount++
            return false
          }
          if (block.type === "server_tool_use" && !toolResultIds.has(block.id)) {
            removedCount++
            return false
          }
          return true
        })

        // If all content was tool_use that got removed, skip the message
        if (filteredContent.length === 0) {
          continue
        }

        result.push({ ...msg, content: filteredContent })
        continue
      }
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool_use`)
  }

  return result
}

/**
 * Ensure Anthropic messages start with a user message.
 */
export function ensureAnthropicStartsWithUser(messages: Array<AnthropicMessage>): Array<AnthropicMessage> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[Sanitizer:Anthropic] Skipped ${startIndex} leading non-user messages`)
  }

  return messages.slice(startIndex)
}
