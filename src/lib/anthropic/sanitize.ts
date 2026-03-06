/**
 * Anthropic message sanitization orchestrator.
 *
 * Combines system-reminder removal, orphan filtering, and empty block cleanup
 * into a single sanitization pipeline for Anthropic messages.
 */

import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type {
  ContentBlock,
  AssistantMessage,
  MessageParam,
  MessagesPayload,
  ContentBlockParam,
  Tool,
  UserMessage,
} from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/sanitize-system-reminder"
import { state } from "~/lib/state"
import { isServerToolResultBlock } from "~/types/api/anthropic"

// ============================================================================
// Shared: Sanitize text blocks in an array
// ============================================================================

/**
 * Remove system-reminder tags from text blocks in an array.
 * Drops blocks whose text becomes empty after sanitization.
 * Returns the original array reference if nothing changed (for cheap identity checks).
 */
function sanitizeTextBlocksInArray<T extends { type: string }>(
  blocks: Array<T>,
  getText: (b: T) => string | undefined,
  setText: (b: T, text: string) => T,
): { blocks: Array<T>; modified: boolean } {
  let modified = false
  const result: Array<T> = []

  for (const block of blocks) {
    const text = getText(block)
    if (text !== undefined) {
      const sanitized = removeSystemReminderTags(text)
      if (sanitized !== text) {
        modified = true
        if (sanitized) {
          result.push(setText(block, sanitized))
        }
        continue
      }
    }
    result.push(block)
  }

  return { blocks: modified ? result : blocks, modified }
}

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

  const { blocks, modified } = sanitizeTextBlocksInArray(
    content,
    (b) => (b.type === "text" ? b.text : undefined),
    (b, text) => ({ ...b, text }),
  )
  return { content: modified ? blocks : content, modified }
}

// ============================================================================
// Message Content Sanitization
// ============================================================================

/**
 * Remove system-reminder tags from Anthropic message content.
 */
function sanitizeMessageParamContent(msg: MessageParam): MessageParam {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      // Don't return empty content — keep original if sanitized is empty
      return sanitized ? { ...msg, content: sanitized } : msg
    }
    return msg
  }

  if (msg.role === "user") {
    // User messages: sanitize text blocks + tool_result content
    let modified = false
    const blocks: Array<ContentBlockParam> = []

    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        const sanitized = removeSystemReminderTags(block.text)
        if (sanitized !== block.text) {
          modified = true
          if (sanitized) blocks.push({ ...block, text: sanitized })
          continue
        }
      } else if (block.type === "tool_result" && block.content) {
        const sanitizedResult = sanitizeToolResultContent(
          block.content as Parameters<typeof sanitizeToolResultContent>[0],
        )
        if (sanitizedResult.modified) {
          modified = true
          blocks.push({ ...block, content: sanitizedResult.content } as ContentBlockParam)
          continue
        }
      }
      blocks.push(block)
    }

    return modified ? ({ role: "user", content: blocks } as UserMessage) : msg
  }

  // Assistant message: only sanitize text blocks
  const { blocks, modified } = sanitizeTextBlocksInArray(
    msg.content,
    (b) => (b.type === "text" && "text" in b ? (b as { text: string }).text : undefined),
    (b, text) => ({ ...b, text }) as ContentBlock,
  )
  return modified ? ({ role: "assistant", content: blocks } as AssistantMessage) : msg
}

/**
 * Remove system-reminder tags from all Anthropic messages.
 */
export function removeAnthropicSystemReminders(messages: Array<MessageParam>): {
  messages: Array<MessageParam>
  modifiedCount: number
} {
  let modifiedCount = 0
  const result = messages.map((msg) => {
    const sanitized = sanitizeMessageParamContent(msg)
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
 * - system-prompt-manager.ts (via config.yaml overrides)
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

  const { blocks, modified } = sanitizeTextBlocksInArray(
    system,
    (b) => b.text,
    (b, text) => ({ ...b, text }),
  )
  return { system: modified ? blocks : system, modified }
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
function filterEmptyAnthropicTextBlocks(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

    // Never modify assistant messages that contain thinking/redacted_thinking blocks.
    // The API validates thinking block signatures against the original response —
    // even removing an adjacent empty text block causes the content array to change,
    // which can trigger "thinking blocks cannot be modified" errors after
    // context_management truncation changes which message becomes the "latest".
    if (
      msg.role === "assistant"
      && msg.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking")
    ) {
      return msg
    }

    const filtered = msg.content.filter((block) => {
      if (block.type === "text" && "text" in block) {
        return block.text.trim() !== ""
      }
      return true
    })

    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered } as MessageParam
  })
}

/**
 * Final pass: remove any empty/whitespace-only text blocks from Anthropic system prompt.
 */
function filterEmptySystemTextBlocks(system: MessagesPayload["system"]): MessagesPayload["system"] {
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
export function processToolBlocks(
  messages: Array<MessageParam>,
  tools: Array<{ name: string }> | undefined,
): {
  messages: Array<MessageParam>
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
  const result: Array<MessageParam> = []
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
      // Process assistant messages: fix tool names and filter orphaned tool_use/server_tool_use.
      // IMPORTANT: Only create a new message object when content is actually modified.
      // Assistant messages may contain thinking/redacted_thinking blocks with signatures
      // that the API validates. Creating a new object (even with identical content) can
      // trigger "thinking blocks cannot be modified" errors after context_management
      // truncation changes which message the API considers the "latest assistant message".
      const newContent: Array<ContentBlock> = []
      let modified = false

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          // Check if orphaned (no corresponding tool_result)
          if (!toolResultIds.has(block.id)) {
            orphanedToolUseCount++
            filteredToolUseIds.add(block.id)
            modified = true
            continue // Skip orphaned tool_use
          }

          // Apply fixes: name casing and input deserialization
          const correctName = nameMap.get(block.name.toLowerCase())
          const needsNameFix = correctName !== undefined && correctName !== block.name
          const needsInputFix = typeof block.input === "string"

          if (needsNameFix || needsInputFix) {
            modified = true
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
            modified = true
            continue // Skip orphaned server_tool_use
          }
          // Ensure input is an object (clients may send it as a JSON string from stream accumulation)
          if (typeof block.input === "string") {
            modified = true
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
            modified = true
            continue // Skip orphaned server tool result
          }
          newContent.push(block as ContentBlock)
        }
      }

      // Skip message if all content was removed
      if (newContent.length === 0) continue

      // Preserve original message object when no modifications were made — this is
      // critical for messages with thinking blocks whose signatures must not change
      result.push(modified ? { ...msg, content: newContent } : msg)
    } else {
      // Process user messages: filter orphaned tool_result/web_search_tool_result
      const newContent: Array<ContentBlockParam> = []

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
function countAnthropicContentBlocks(messages: Array<MessageParam>): number {
  let count = 0
  for (const msg of messages) {
    count += typeof msg.content === "string" ? 1 : msg.content.length
  }
  return count
}

export interface SanitizationStats {
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  systemReminderRemovals: number
  totalBlocksRemoved: number
}

/**
 * Sanitize Anthropic messages by filtering orphaned tool blocks and system reminders.
 *
 * Returns both convenience totals (removedCount, systemReminderRemovals) for backward
 * compatibility, and structured stats for callers that need detail.
 */
export function sanitizeAnthropicMessages(
  payload: MessagesPayload,
): SanitizeResult<MessagesPayload> & { stats: SanitizationStats } {
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
  const totalBlocksRemoved = originalBlocks - newBlocks
  const emptyTextBlocksRemoved =
    totalBlocksRemoved - toolResult.orphanedToolUseCount - toolResult.orphanedToolResultCount

  if (totalBlocksRemoved > 0 && (toolResult.orphanedToolUseCount > 0 || toolResult.orphanedToolResultCount > 0)) {
    const parts: Array<string> = []
    if (toolResult.orphanedToolUseCount > 0) parts.push(`${toolResult.orphanedToolUseCount} orphaned tool_use`)
    if (toolResult.orphanedToolResultCount > 0) parts.push(`${toolResult.orphanedToolResultCount} orphaned tool_result`)
    if (emptyTextBlocksRemoved > 0) parts.push(`${emptyTextBlocksRemoved} empty text blocks`)
    consola.info(`[Sanitizer:Anthropic] Removed ${totalBlocksRemoved} content blocks (${parts.join(", ")})`)
  }

  return {
    payload: { ...payload, system: finalSystem, messages },
    removedCount: totalBlocksRemoved,
    systemReminderRemovals,
    stats: {
      orphanedToolUseCount: toolResult.orphanedToolUseCount,
      orphanedToolResultCount: toolResult.orphanedToolResultCount,
      fixedNameCount: toolResult.fixedNameCount,
      emptyTextBlocksRemoved: Math.max(0, emptyTextBlocksRemoved),
      systemReminderRemovals,
      totalBlocksRemoved,
    },
  }
}

// ============================================================================
// Server Tool Rewriting
// ============================================================================

/**
 * Server-side tool type prefixes that need special handling.
 * These tools have a special `type` field (e.g., "web_search_20250305")
 * and are normally executed by Anthropic's servers.
 */
interface ServerToolConfig {
  description: string
  input_schema: Record<string, unknown>
  /** If true, this tool will be removed from the request and Claude won't see it */
  remove?: boolean
  /** Error message to show if the tool is removed */
  removalReason?: string
}

const SERVER_TOOL_CONFIGS: Record<string, ServerToolConfig> = {
  web_search: {
    description:
      "Search the web for current information. "
      + "Returns web search results that can help answer questions about recent events, "
      + "current data, or information that may have changed since your knowledge cutoff.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  web_fetch: {
    description:
      "Fetch content from a URL. "
      + "NOTE: This is a client-side tool - the client must fetch the URL and return the content.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  code_execution: {
    description: "Execute code in a sandbox. " + "NOTE: This is a client-side tool - the client must execute the code.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to execute" },
        language: { type: "string", description: "The programming language" },
      },
      required: ["code"],
    },
  },
  computer: {
    description:
      "Control computer desktop. " + "NOTE: This is a client-side tool - the client must handle computer control.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The action to perform" },
      },
      required: ["action"],
    },
  },
}

// Match tool.type (e.g., "web_search_20250305") to a server tool config
function findServerToolConfig(type: string | undefined): ServerToolConfig | null {
  if (!type) return null
  for (const [prefix, config] of Object.entries(SERVER_TOOL_CONFIGS)) {
    if (type.startsWith(prefix)) return config
  }
  return null
}

/**
 * Convert server-side tools to custom tools, or pass them through unchanged.
 * Only converts when state.rewriteAnthropicTools is enabled.
 */
export function convertServerToolsToCustom(tools: Array<Tool> | undefined): Array<Tool> | undefined {
  if (!tools) return undefined

  // When rewriting is disabled, pass all tools through unchanged
  if (!state.rewriteAnthropicTools) return tools

  const result: Array<Tool> = []

  for (const tool of tools) {
    const config = findServerToolConfig(tool.type)
    if (!config) {
      result.push(tool)
      continue
    }

    if (config.remove) {
      consola.warn(`[DirectAnthropic] Removing server tool: ${tool.name}. Reason: ${config.removalReason}`)
      continue
    }

    consola.debug(`[DirectAnthropic] Converting server tool to custom: ${tool.name} (type: ${tool.type})`)
    result.push({
      name: tool.name,
      description: config.description,
      input_schema: config.input_schema,
    })
  }

  return result.length > 0 ? result : undefined
}
