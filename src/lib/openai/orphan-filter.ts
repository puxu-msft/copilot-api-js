/**
 * OpenAI orphaned tool block filtering.
 *
 * Filters orphaned tool messages and tool_calls from OpenAI messages
 * to ensure API compatibility.
 */

import consola from "consola"

import type { Message, ToolCall } from "./client"

/**
 * Get tool_call IDs from an OpenAI assistant message.
 */
export function getOpenAIToolCallIds(msg: Message): Array<string> {
  if (msg.role === "assistant" && msg.tool_calls) {
    return msg.tool_calls.map((tc: ToolCall) => tc.id)
  }
  return []
}

/**
 * Get tool_result IDs from OpenAI tool messages.
 */
export function getOpenAIToolResultIds(messages: Array<Message>): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      ids.add(msg.tool_call_id)
    }
  }
  return ids
}

/**
 * Filter orphaned tool messages from OpenAI messages.
 */
export function filterOpenAIOrphanedToolResults(messages: Array<Message>): Array<Message> {
  // Collect all available tool_call IDs
  const toolCallIds = new Set<string>()
  for (const msg of messages) {
    for (const id of getOpenAIToolCallIds(msg)) {
      toolCallIds.add(id)
    }
  }

  // Filter out orphaned tool messages
  let removedCount = 0
  const filtered = messages.filter((msg) => {
    if (msg.role === "tool" && msg.tool_call_id && !toolCallIds.has(msg.tool_call_id)) {
      removedCount++
      return false
    }
    return true
  })

  if (removedCount > 0) {
    consola.debug(`[Sanitizer:OpenAI] Filtered ${removedCount} orphaned tool_result`)
  }

  return filtered
}

/**
 * Filter orphaned tool_calls from OpenAI assistant messages.
 */
export function filterOpenAIOrphanedToolUse(messages: Array<Message>): Array<Message> {
  const toolResultIds = getOpenAIToolResultIds(messages)

  // Filter out orphaned tool_calls from assistant messages
  const result: Array<Message> = []
  let removedCount = 0

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      const filteredToolCalls = msg.tool_calls.filter((tc: ToolCall) => {
        if (!toolResultIds.has(tc.id)) {
          removedCount++
          return false
        }
        return true
      })

      // If all tool_calls were removed but there's still content, keep the message
      if (filteredToolCalls.length === 0) {
        if (msg.content) {
          result.push({ ...msg, tool_calls: undefined })
        }
        // Skip message entirely if no content and no tool_calls
        continue
      }

      result.push({ ...msg, tool_calls: filteredToolCalls })
      continue
    }

    result.push(msg)
  }

  if (removedCount > 0) {
    consola.debug(`[Sanitizer:OpenAI] Filtered ${removedCount} orphaned tool_use`)
  }

  return result
}

/**
 * Ensure OpenAI messages start with a user message.
 */
export function ensureOpenAIStartsWithUser(messages: Array<Message>): Array<Message> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[Sanitizer:OpenAI] Skipped ${startIndex} leading non-user messages`)
  }

  return messages.slice(startIndex)
}

/**
 * Extract system/developer messages from the beginning of OpenAI messages.
 */
export function extractOpenAISystemMessages(messages: Array<Message>): {
  systemMessages: Array<Message>
  conversationMessages: Array<Message>
} {
  let splitIndex = 0
  while (splitIndex < messages.length) {
    const role = messages[splitIndex].role
    if (role !== "system" && role !== "developer") break
    splitIndex++
  }

  return {
    systemMessages: messages.slice(0, splitIndex),
    conversationMessages: messages.slice(splitIndex),
  }
}
