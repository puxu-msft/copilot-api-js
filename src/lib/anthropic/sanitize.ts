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

import { isServerToolResultBlock } from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/system-reminder"

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
// Combined Tool Block Processing
// ============================================================================

/**
 * Parse a potentially stringified JSON input into a proper object.
 * Handles double-serialized strings (e.g., "\"{ ... }\"") by parsing iteratively.
 */
function parseStringifiedInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "string") return input as Record<string, unknown>
  try {
    let parsed: unknown = input
    while (typeof parsed === "string") {
      parsed = JSON.parse(parsed)
    }
    return (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Process all tool-related operations in a single pass:
 * 1. Fix tool_use name casing
 * 2. Filter orphaned tool_result blocks
 * 3. Filter orphaned tool_use blocks
 *
 * This combines what were previously three separate operations (each with their own iterations)
 * into two passes through the messages array for better performance.
 */
function processToolBlocks(
  messages: Array<AnthropicMessage>,
  tools: Array<{ name: string }> | undefined,
): {
  messages: Array<AnthropicMessage>
  fixedNameCount: number
  orphanedToolUseCount: number
  orphanedToolResultCount: number
} {
  // Build case-insensitive tool name map if tools are provided
  const nameMap = new Map<string, string>()
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      nameMap.set(tool.name.toLowerCase(), tool.name)
    }
  }

  // Pass 1: Collect all tool_use/server_tool_use and tool_result/web_search_tool_result IDs
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === "string") continue

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if ((block.type === "tool_use" || block.type === "server_tool_use") && block.id) {
          toolUseIds.add(block.id)
        }
        // Server tool results can appear in assistant messages (server-side execution).
        // Collect their IDs so the corresponding server_tool_use is not treated as orphaned.
        if (isServerToolResultBlock(block)) {
          toolResultIds.add(block.tool_use_id)
        }
      }
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id)
        } else if (isServerToolResultBlock(block)) {
          toolResultIds.add(block.tool_use_id)
        }
      }
    }
  }

  // Pass 2: Process messages - fix names and filter orphans
  const result: Array<AnthropicMessage> = []
  let fixedNameCount = 0
  let orphanedToolUseCount = 0
  let orphanedToolResultCount = 0
  // Track tool_use IDs that were filtered (orphaned) so their tool_results are also filtered
  const filteredToolUseIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    if (msg.role === "assistant") {
      // Process assistant messages: fix tool names and filter orphaned tool_use/server_tool_use
      const newContent: Array<AnthropicAssistantContentBlock> = []

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          // Check if orphaned (no corresponding tool_result)
          if (!toolResultIds.has(block.id)) {
            orphanedToolUseCount++
            filteredToolUseIds.add(block.id)
            continue // Skip orphaned tool_use
          }

          // Apply fixes: name casing and input deserialization
          const correctName = nameMap.get(block.name.toLowerCase())
          const needsNameFix = correctName !== undefined && correctName !== block.name
          const needsInputFix = typeof block.input === "string"

          if (needsNameFix || needsInputFix) {
            const fixed = { ...block } as typeof block
            if (needsNameFix) {
              fixedNameCount++
              ;(fixed as { name: string }).name = correctName
            }
            if (needsInputFix) {
              ;(fixed as { input: Record<string, unknown> }).input = parseStringifiedInput(block.input)
            }
            newContent.push(fixed)
          } else {
            newContent.push(block)
          }
        } else if (block.type === "server_tool_use") {
          // Check if orphaned (no corresponding web_search_tool_result)
          if (!toolResultIds.has(block.id)) {
            orphanedToolUseCount++
            filteredToolUseIds.add(block.id)
            continue // Skip orphaned server_tool_use
          }
          // Ensure input is an object (clients may send it as a JSON string from stream accumulation)
          if (typeof block.input === "string") {
            newContent.push({ ...block, input: parseStringifiedInput(block.input) })
          } else {
            newContent.push(block)
          }
        } else {
          // For server tool results in assistant messages (e.g., tool_search_tool_result),
          // check if their corresponding server_tool_use is still present
          if (
            isServerToolResultBlock(block)
            && (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id))
          ) {
            orphanedToolResultCount++
            continue // Skip orphaned server tool result
          }
          newContent.push(block as AnthropicAssistantContentBlock)
        }
      }

      // Skip message if all content was removed
      if (newContent.length === 0) continue

      result.push({ ...msg, content: newContent })
    } else {
      // Process user messages: filter orphaned tool_result/web_search_tool_result
      const newContent: Array<AnthropicUserContentBlock> = []

      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // Check if orphaned (no corresponding tool_use) or tool_use was filtered
          if (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id)) {
            orphanedToolResultCount++
            continue // Skip orphaned tool_result
          }
        } else if (isServerToolResultBlock(block)) {
          // Check if orphaned (no corresponding server_tool_use) or server_tool_use was filtered
          if (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id)) {
            orphanedToolResultCount++
            continue // Skip orphaned server tool result
          }
        } else if (
          (block as unknown as Record<string, unknown>).type !== "text"
          && (block as unknown as Record<string, unknown>).type !== "image"
        ) {
          // Unknown block type without tool_use_id (e.g., corrupted server tool result
          // from older history where tool_use_id was lost during conversion).
          // Filter it out to prevent API errors.
          orphanedToolResultCount++
          continue
        }
        newContent.push(block)
      }

      // Skip message if all content was removed
      if (newContent.length === 0) continue

      result.push({ ...msg, content: newContent })
    }
  }

  return {
    messages: result,
    fixedNameCount,
    orphanedToolUseCount,
    orphanedToolResultCount,
  }
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

  // Process all tool-related operations in a single pass:
  // - Fix tool_use name casing (e.g., "bash" → "Bash")
  // - Filter orphaned tool_result blocks
  // - Filter orphaned tool_use blocks
  const toolResult = processToolBlocks(messages, payload.tools)
  messages = toolResult.messages

  if (toolResult.fixedNameCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Fixed ${toolResult.fixedNameCount} tool name casing mismatches`)
  }

  // Final safety net: remove any remaining empty/whitespace-only text blocks
  // This catches empty blocks from any source (input, sanitization, truncation)
  messages = filterEmptyAnthropicTextBlocks(messages)
  const finalSystem = filterEmptySystemTextBlocks(sanitizedSystem)

  const newBlocks = countAnthropicContentBlocks(messages)
  const removedCount = originalBlocks - newBlocks

  if (removedCount > 0) {
    const emptyTextCount = removedCount - toolResult.orphanedToolUseCount - toolResult.orphanedToolResultCount
    // Only log if there are meaningful removals (not just empty text blocks)
    if (toolResult.orphanedToolUseCount > 0 || toolResult.orphanedToolResultCount > 0) {
      const parts: Array<string> = []
      if (toolResult.orphanedToolUseCount > 0) parts.push(`${toolResult.orphanedToolUseCount} orphaned tool_use`)
      if (toolResult.orphanedToolResultCount > 0)
        parts.push(`${toolResult.orphanedToolResultCount} orphaned tool_result`)
      if (emptyTextCount > 0) parts.push(`${emptyTextCount} empty text blocks`)
      consola.info(`[Sanitizer:Anthropic] Removed ${removedCount} content blocks (${parts.join(", ")})`)
    }
  }

  return {
    payload: { ...payload, system: finalSystem, messages },
    removedCount,
    systemReminderRemovals,
  }
}
