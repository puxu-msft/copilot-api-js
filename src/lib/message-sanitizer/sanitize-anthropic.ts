/**
 * Anthropic message sanitization orchestrator.
 *
 * Combines system-reminder removal, orphan filtering, and empty block cleanup
 * into a single sanitization pipeline for Anthropic messages.
 */

import consola from "consola"

import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "~/types/api/anthropic"

import { filterAnthropicOrphanedToolResults, filterAnthropicOrphanedToolUse } from "./orphan-filter-anthropic"
import { removeSystemReminderTags } from "./system-reminder"

// ============================================================================
// Tool Result Content Sanitization
// ============================================================================

/**
 * Sanitize tool_result content (can be string or array of text/image blocks).
 * Returns the sanitized content and whether it was modified.
 */
function sanitizeToolResultContent(
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: unknown }>,
): { content: typeof content; modified: boolean } {
  if (typeof content === "string") {
    const sanitized = removeSystemReminderTags(content)
    // Don't return empty content — keep original if sanitized is empty
    if (!sanitized && sanitized !== content) {
      return { content, modified: false }
    }
    return { content: sanitized, modified: sanitized !== content }
  }

  // Handle array of content blocks using reduce to track modifications
  const result = content.reduce<{
    blocks: typeof content
    modified: boolean
  }>(
    (acc, block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const sanitized = removeSystemReminderTags(block.text)
        if (sanitized !== block.text) {
          if (sanitized) {
            acc.blocks.push({ ...block, text: sanitized })
          }
          acc.modified = true
          return acc
        }
      }
      acc.blocks.push(block)
      return acc
    },
    { blocks: [], modified: false },
  )

  return {
    content: result.modified ? result.blocks : content,
    modified: result.modified,
  }
}

// ============================================================================
// Message Content Sanitization
// ============================================================================

/**
 * Remove system-reminder tags from Anthropic message content.
 */
function sanitizeAnthropicMessageContent(msg: AnthropicMessage): AnthropicMessage {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      // Don't return empty content — keep original if sanitized is empty
      return sanitized ? { ...msg, content: sanitized } : msg
    }
    return msg
  }
  if (msg.role === "user") {
    const result = msg.content.reduce<{
      blocks: Array<AnthropicUserContentBlock>
      modified: boolean
    }>(
      (acc, block) => {
        if (block.type === "text" && typeof block.text === "string") {
          const sanitized = removeSystemReminderTags(block.text)
          if (sanitized !== block.text) {
            if (sanitized) {
              acc.blocks.push({ ...block, text: sanitized })
            }
            acc.modified = true
            return acc
          }
        }
        // Handle tool_result blocks
        if (block.type === "tool_result" && block.content) {
          const sanitizedResult = sanitizeToolResultContent(block.content)
          if (sanitizedResult.modified) {
            acc.blocks.push({
              ...block,
              content: sanitizedResult.content,
            } as AnthropicUserContentBlock)
            acc.modified = true
            return acc
          }
        }
        acc.blocks.push(block)
        return acc
      },
      { blocks: [], modified: false },
    )
    if (result.modified) {
      return { role: "user", content: result.blocks } as AnthropicUserMessage
    }
    return msg
  }

  // Assistant message
  const result = msg.content.reduce<{
    blocks: Array<AnthropicAssistantContentBlock>
    modified: boolean
  }>(
    (acc, block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const sanitized = removeSystemReminderTags(block.text)
        if (sanitized !== block.text) {
          if (sanitized) {
            acc.blocks.push({ ...block, text: sanitized })
          }
          acc.modified = true
          return acc
        }
      }
      acc.blocks.push(block)
      return acc
    },
    { blocks: [], modified: false },
  )
  if (result.modified) {
    return {
      role: "assistant",
      content: result.blocks,
    } as AnthropicAssistantMessage
  }
  return msg
}

/**
 * Remove system-reminder tags from all Anthropic messages.
 */
export function removeAnthropicSystemReminders(messages: Array<AnthropicMessage>): {
  messages: Array<AnthropicMessage>
  modifiedCount: number
} {
  let modifiedCount = 0
  const result = messages.map((msg) => {
    const sanitized = sanitizeAnthropicMessageContent(msg)
    if (sanitized !== msg) modifiedCount++
    return sanitized
  })
  return { messages: result, modifiedCount }
}

// ============================================================================
// System Prompt Sanitization
// ============================================================================

/**
 * Sanitize Anthropic system prompt (can be string or array of text blocks).
 * Only removes system-reminder tags here.
 *
 * NOTE: Restrictive statement filtering is handled separately by:
 * - security-research-mode.ts (when --security-research is enabled)
 * This avoids duplicate processing of the system prompt.
 */
function sanitizeAnthropicSystemPrompt(system: string | Array<{ type: "text"; text: string }> | undefined): {
  system: typeof system
  modified: boolean
} {
  if (!system) {
    return { system, modified: false }
  }

  if (typeof system === "string") {
    const sanitized = removeSystemReminderTags(system)
    return { system: sanitized, modified: sanitized !== system }
  }

  // Handle array of text blocks
  const result = system.reduce<{
    blocks: Array<{ type: "text"; text: string }>
    modified: boolean
  }>(
    (acc, block) => {
      const sanitized = removeSystemReminderTags(block.text)
      if (sanitized !== block.text) {
        if (sanitized) {
          acc.blocks.push({ ...block, text: sanitized })
        }
        acc.modified = true
        return acc
      }
      acc.blocks.push(block)
      return acc
    },
    { blocks: [], modified: false },
  )

  return {
    system: result.modified ? result.blocks : system,
    modified: result.modified,
  }
}

// ============================================================================
// Empty Block Cleanup
// ============================================================================

/**
 * Final pass: remove any empty/whitespace-only text content blocks from Anthropic messages.
 * This is a safety net that catches empty blocks regardless of how they were produced
 * (original input, sanitization, truncation, etc.).
 * Anthropic API rejects text blocks with empty text: "text content blocks must be non-empty"
 */
function filterEmptyAnthropicTextBlocks(messages: Array<AnthropicMessage>): Array<AnthropicMessage> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

    const filtered = msg.content.filter((block) => {
      if (block.type === "text" && "text" in block) {
        return block.text.trim() !== ""
      }
      return true
    })

    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered } as AnthropicMessage
  })
}

/**
 * Final pass: remove any empty/whitespace-only text blocks from Anthropic system prompt.
 */
function filterEmptySystemTextBlocks(system: AnthropicMessagesPayload["system"]): AnthropicMessagesPayload["system"] {
  if (!system || typeof system === "string") return system
  return system.filter((block) => block.text.trim() !== "")
}

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Count total content blocks in Anthropic messages.
 */
function countAnthropicContentBlocks(messages: Array<AnthropicMessage>): number {
  let count = 0
  for (const msg of messages) {
    count += typeof msg.content === "string" ? 1 : msg.content.length
  }
  return count
}

/**
 * Sanitize Anthropic messages by filtering orphaned tool blocks and system reminders.
 *
 * @returns Sanitized payload and count of removed items
 */
export function sanitizeAnthropicMessages(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload
  removedCount: number
  systemReminderRemovals: number
} {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  // Remove system-reminder tags from system prompt
  const { system: sanitizedSystem } = sanitizeAnthropicSystemPrompt(payload.system)

  // Remove system-reminder tags from all messages
  const reminderResult = removeAnthropicSystemReminders(messages)
  messages = reminderResult.messages
  const systemReminderRemovals = reminderResult.modifiedCount

  // Filter orphaned tool_result and tool_use blocks
  messages = filterAnthropicOrphanedToolResults(messages)
  messages = filterAnthropicOrphanedToolUse(messages)

  // Final safety net: remove any remaining empty/whitespace-only text blocks
  // This catches empty blocks from any source (input, sanitization, truncation)
  messages = filterEmptyAnthropicTextBlocks(messages)
  const finalSystem = filterEmptySystemTextBlocks(sanitizedSystem)

  const newBlocks = countAnthropicContentBlocks(messages)
  const removedCount = originalBlocks - newBlocks

  if (removedCount > 0) {
    consola.info(`[Sanitizer:Anthropic] Filtered ${removedCount} orphaned tool blocks`)
  }

  return {
    payload: { ...payload, system: finalSystem, messages },
    removedCount,
    systemReminderRemovals,
  }
}
