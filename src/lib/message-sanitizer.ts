/**
 * Message sanitizer module.
 *
 * Provides unified sanitization for both Anthropic and OpenAI message formats.
 * Filters orphaned tool_result and tool_use blocks to ensure API compatibility.
 *
 * This module should be called before sending messages to any API to ensure
 * that all tool blocks have proper references:
 * - Every tool_result must reference an existing tool_use
 * - Every tool_use must have a corresponding tool_result
 *
 * Orphaned messages can occur when:
 * - Client sends malformed message history
 * - Previous truncation/compaction was interrupted
 * - Message history was edited externally
 */

import consola from "consola"

import type {
  ChatCompletionsPayload,
  Message,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
} from "~/types/api/anthropic"

// ============================================================================
// Anthropic Format
// ============================================================================

/**
 * Get tool_use IDs from an Anthropic assistant message.
 */
export function getAnthropicToolUseIds(msg: AnthropicMessage): Array<string> {
  if (msg.role !== "assistant") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_use") {
      ids.push(block.id)
    }
  }
  return ids
}

/**
 * Get tool_result IDs from an Anthropic user message.
 */
export function getAnthropicToolResultIds(
  msg: AnthropicMessage,
): Array<string> {
  if (msg.role !== "user") return []
  if (typeof msg.content === "string") return []

  const ids: Array<string> = []
  for (const block of msg.content) {
    if (block.type === "tool_result") {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Filter orphaned tool_result blocks from Anthropic messages.
 */
export function filterAnthropicOrphanedToolResults(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
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
      const hasOrphanedToolResult = toolResultIds.some(
        (id) => !toolUseIds.has(id),
      )

      if (hasOrphanedToolResult) {
        // Filter out orphaned tool_result blocks
        const filteredContent = msg.content.filter((block) => {
          if (
            block.type === "tool_result"
            && !toolUseIds.has(block.tool_use_id)
          ) {
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
    consola.debug(
      `[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool_result`,
    )
  }

  return result
}

/**
 * Filter orphaned tool_use blocks from Anthropic messages.
 */
export function filterAnthropicOrphanedToolUse(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
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
      const hasOrphanedToolUse = msgToolUseIds.some(
        (id) => !toolResultIds.has(id),
      )

      if (hasOrphanedToolUse) {
        // Filter out orphaned tool_use blocks
        const filteredContent = msg.content.filter((block) => {
          if (block.type === "tool_use" && !toolResultIds.has(block.id)) {
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
    consola.debug(
      `[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool_use`,
    )
  }

  return result
}

/**
 * Ensure Anthropic messages start with a user message.
 */
export function ensureAnthropicStartsWithUser(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(
      `[Sanitizer:Anthropic] Skipped ${startIndex} leading non-user messages`,
    )
  }

  return messages.slice(startIndex)
}

/**
 * Count total content blocks in Anthropic messages.
 */
function countAnthropicContentBlocks(
  messages: Array<AnthropicMessage>,
): number {
  let count = 0
  for (const msg of messages) {
    count += typeof msg.content === "string" ? 1 : msg.content.length
  }
  return count
}

/**
 * Sanitize Anthropic messages by filtering orphaned tool blocks.
 *
 * @returns Sanitized payload and count of removed items
 */
export function sanitizeAnthropicMessages(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload
  removedCount: number
} {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  // Filter orphaned tool_result and tool_use blocks
  messages = filterAnthropicOrphanedToolResults(messages)
  messages = filterAnthropicOrphanedToolUse(messages)

  const newBlocks = countAnthropicContentBlocks(messages)
  const removedCount = originalBlocks - newBlocks

  if (removedCount > 0) {
    consola.info(
      `[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool blocks`,
    )
  }

  return {
    payload: { ...payload, messages },
    removedCount,
  }
}

// ============================================================================
// OpenAI Format
// ============================================================================

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
export function filterOpenAIOrphanedToolResults(
  messages: Array<Message>,
): Array<Message> {
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
    if (
      msg.role === "tool"
      && msg.tool_call_id
      && !toolCallIds.has(msg.tool_call_id)
    ) {
      removedCount++
      return false
    }
    return true
  })

  if (removedCount > 0) {
    consola.debug(
      `[Sanitizer:OpenAI] Filtered ${removedCount} orphaned tool_result`,
    )
  }

  return filtered
}

/**
 * Filter orphaned tool_calls from OpenAI assistant messages.
 */
export function filterOpenAIOrphanedToolUse(
  messages: Array<Message>,
): Array<Message> {
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
    consola.debug(
      `[Sanitizer:OpenAI] Filtered ${removedCount} orphaned tool_use`,
    )
  }

  return result
}

/**
 * Ensure OpenAI messages start with a user message.
 */
export function ensureOpenAIStartsWithUser(
  messages: Array<Message>,
): Array<Message> {
  let startIndex = 0
  while (startIndex < messages.length && messages[startIndex].role !== "user") {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(
      `[Sanitizer:OpenAI] Skipped ${startIndex} leading non-user messages`,
    )
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

/**
 * Sanitize OpenAI messages by filtering orphaned tool messages.
 *
 * @returns Sanitized payload and count of removed items
 */
export function sanitizeOpenAIMessages(payload: ChatCompletionsPayload): {
  payload: ChatCompletionsPayload
  removedCount: number
} {
  const { systemMessages, conversationMessages } = extractOpenAISystemMessages(
    payload.messages,
  )

  let messages = conversationMessages
  const originalCount = messages.length

  // Filter orphaned tool_result and tool_use messages
  messages = filterOpenAIOrphanedToolResults(messages)
  messages = filterOpenAIOrphanedToolUse(messages)

  const removedCount = originalCount - messages.length

  if (removedCount > 0) {
    consola.info(
      `[Sanitizer:OpenAI] Filtered ${removedCount} orphaned tool messages`,
    )
  }

  return {
    payload: { ...payload, messages: [...systemMessages, ...messages] },
    removedCount,
  }
}
