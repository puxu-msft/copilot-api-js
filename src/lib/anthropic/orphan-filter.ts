/**
 * Anthropic orphaned tool block filtering.
 *
 * Filters orphaned tool_result and tool_use blocks from Anthropic messages
 * to ensure API compatibility. Orphaned blocks can occur when:
 * - Previous truncation/compaction was interrupted
 * - Client sends malformed message history
 * - Message history was edited externally
 *
 * Server tool results (e.g., tool_search_tool_result) can appear in ASSISTANT
 * messages (inline with server_tool_use), not just in user messages.
 */

import consola from "consola"

import type { MessageParam } from "~/types/api/anthropic"

import { isServerToolResultBlock, isToolResultBlock } from "~/types/api/anthropic"

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
 * Filter orphaned tool_result blocks from Anthropic messages.
 * Handles both user messages (tool_result, web_search_tool_result) and
 * assistant messages (server tool results like tool_search_tool_result).
 */
export function filterAnthropicOrphanedToolResults(messages: Array<MessageParam>): Array<MessageParam> {
  // Collect all tool_use IDs
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolUseIds(msg)) {
      toolUseIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_results
  const result: Array<MessageParam> = []
  let removedToolResult = 0
  let removedServerToolResult = 0

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    // Check for orphaned tool results in both user and assistant messages
    const toolResultIds = getAnthropicToolResultIds(msg)
    const hasOrphanedToolResult = toolResultIds.some((id) => !toolUseIds.has(id))

    if (hasOrphanedToolResult) {
      const filteredContent = msg.content.filter((block) => {
        if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
          removedToolResult++
          return false
        }
        if (isServerToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
          removedServerToolResult++
          return false
        }
        return true
      })

      if (filteredContent.length === 0) {
        continue
      }

      result.push({ ...msg, content: filteredContent } as MessageParam)
      continue
    }

    result.push(msg)
  }

  const totalRemoved = removedToolResult + removedServerToolResult
  if (totalRemoved > 0) {
    const parts: Array<string> = []
    if (removedToolResult > 0) parts.push(`${removedToolResult} tool_result`)
    if (removedServerToolResult > 0) parts.push(`${removedServerToolResult} server_tool_result`)
    consola.debug(`[Sanitizer:Anthropic] Filtered ${totalRemoved} orphaned tool results (${parts.join(", ")})`)
  }

  return result
}

/**
 * Filter orphaned tool_use blocks from Anthropic messages.
 * Also filters orphaned server tool results in the same assistant message
 * when their corresponding server_tool_use has been removed.
 */
export function filterAnthropicOrphanedToolUse(messages: Array<MessageParam>): Array<MessageParam> {
  // Collect all tool_result IDs
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolResultIds(msg)) {
      toolResultIds.add(id)
    }
  }

  // Also collect tool_use IDs (needed to check if server tool results have matching server_tool_use)
  const toolUseIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getAnthropicToolUseIds(msg)) {
      toolUseIds.add(id)
    }
  }

  // Filter messages, removing orphaned tool_use from assistant messages
  const result: Array<MessageParam> = []
  let removedToolUse = 0
  let removedServerToolUse = 0
  let removedServerToolResult = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content !== "string") {
      const msgToolUseIds = getAnthropicToolUseIds(msg)
      const hasOrphanedToolUse = msgToolUseIds.some((id) => !toolResultIds.has(id))

      // Also check for orphaned server tool results in this assistant message
      const hasOrphanedServerResult = msg.content.some(
        (block) => isServerToolResultBlock(block) && !toolUseIds.has(block.tool_use_id),
      )

      if (hasOrphanedToolUse || hasOrphanedServerResult) {
        // First pass: determine which tool_use IDs survive
        const survivingToolUseIds = new Set<string>()
        for (const block of msg.content) {
          if (block.type === "tool_use" && toolResultIds.has(block.id)) {
            survivingToolUseIds.add(block.id)
          }
          if (block.type === "server_tool_use" && toolResultIds.has(block.id)) {
            survivingToolUseIds.add(block.id)
          }
        }

        // Second pass: filter blocks
        const filteredContent = msg.content.filter((block) => {
          if (block.type === "tool_use" && !toolResultIds.has(block.id)) {
            removedToolUse++
            return false
          }
          if (block.type === "server_tool_use" && !toolResultIds.has(block.id)) {
            removedServerToolUse++
            return false
          }
          // Remove server tool results whose server_tool_use was just removed
          if (isServerToolResultBlock(block) && !survivingToolUseIds.has(block.tool_use_id)) {
            removedServerToolResult++
            return false
          }
          return true
        })

        if (filteredContent.length === 0) {
          continue
        }

        result.push({ ...msg, content: filteredContent } as MessageParam)
        continue
      }
    }

    result.push(msg)
  }

  const totalRemoved = removedToolUse + removedServerToolUse + removedServerToolResult
  if (totalRemoved > 0) {
    const parts: Array<string> = []
    if (removedToolUse > 0) parts.push(`${removedToolUse} tool_use`)
    if (removedServerToolUse > 0) parts.push(`${removedServerToolUse} server_tool_use`)
    if (removedServerToolResult > 0) parts.push(`${removedServerToolResult} server_tool_result`)
    consola.debug(`[Sanitizer:Anthropic] Filtered ${totalRemoved} orphaned tool blocks (${parts.join(", ")})`)
  }

  return result
}

/**
 * Ensure Anthropic messages start with a user message.
 */
export function ensureAnthropicStartsWithUser(messages: Array<MessageParam>): Array<MessageParam> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[Sanitizer:Anthropic] Skipped ${startIndex} leading non-user messages`)
  }

  return messages.slice(startIndex)
}
