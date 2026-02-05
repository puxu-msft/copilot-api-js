/**
 * Message sanitizer module.
 *
 * Provides unified sanitization for both Anthropic and OpenAI message formats.
 * - Filters orphaned tool_result and tool_use blocks to ensure API compatibility
 * - Removes system-reminder tags from message content
 * - Filters restrictive/harmful statements from system prompts
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
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "~/types/api/anthropic"

// ============================================================================
// System Reminder Tag Removal
// ============================================================================

/**
 * Regex pattern to match <system-reminder>...</system-reminder> tags.
 * Uses non-greedy matching to handle multiple tags.
 */
const SYSTEM_REMINDER_PATTERN =
  /<system-reminder>([\s\S]*?)<\/system-reminder>/g

/**
 * Known system-reminder filter types.
 * Each type has a key, description, pattern, and whether it's enabled by default.
 */
export interface SystemReminderFilter {
  key: string
  description: string
  pattern: RegExp
  defaultEnabled: boolean
}

/**
 * All known Claude Code system-reminder types that can be filtered.
 * Users can configure which ones to enable/disable.
 *
 * IMPORTANT: These are patterns that appear INSIDE <system-reminder> tags.
 * Content that appears directly in messages (like billing headers, git status)
 * should NOT be in this list - they need different handling.
 *
 * Reference: These are injected by Claude Code into tool results and user messages.
 * See: https://docs.anthropic.com/en/docs/claude-code
 */
export const SYSTEM_REMINDER_FILTERS: Array<SystemReminderFilter> = [
  // =========================================================================
  // DEFAULT ENABLED - Malware analysis reminder
  // This reminder appears after reading files and interferes with code assistance
  // =========================================================================
  {
    key: "malware",
    description:
      "Malware analysis reminder - 'should consider whether it would be considered malware'",
    pattern: /whether it would be considered malware/i,
    defaultEnabled: true,
  },

  // =========================================================================
  // DEFAULT DISABLED - IDE Context Notifications
  // These provide context about what the user is doing in their IDE
  // =========================================================================
  {
    key: "user-file-opened",
    description:
      "User opened a file in IDE - 'The user opened the file X in the IDE'",
    pattern: /The user opened the file .* in the IDE/i,
    defaultEnabled: false,
  },
  {
    key: "user-selection",
    description:
      "User selected lines from a file - 'The user selected the lines X to Y'",
    pattern: /The user selected the lines \d+ to \d+/i,
    defaultEnabled: false,
  },
  {
    key: "ide-diagnostics",
    description:
      "IDE diagnostic issues detected - 'new diagnostic issues were detected'",
    pattern: /new diagnostic issues were detected|<new-diagnostics>/i,
    defaultEnabled: false,
  },

  // =========================================================================
  // DEFAULT DISABLED - File/Code Change Notifications
  // =========================================================================
  {
    key: "file-modified",
    description:
      "File was modified by user or linter - 'was modified, either by the user or by a linter'",
    pattern: /was modified, either by the user or by a linter/i,
    defaultEnabled: false,
  },

  // =========================================================================
  // DEFAULT DISABLED - Task/Workflow Reminders
  // =========================================================================
  {
    key: "task-tools",
    description:
      "Task tools reminder - 'The task tools haven't been used recently'",
    pattern: /The task tools haven't been used recently/i,
    defaultEnabled: false,
  },
  {
    key: "user-message-pending",
    description:
      "User sent new message while working - 'IMPORTANT: After completing your current task'",
    pattern:
      /IMPORTANT:.*?After completing your current task.*?address the user's message/i,
    defaultEnabled: false,
  },

  // =========================================================================
  // DEFAULT DISABLED - Hook/Session Notifications
  // =========================================================================
  {
    key: "hook-success",
    description: "Hook execution success - 'hook success', 'Hook.*Success'",
    pattern: /hook success|Hook.*?Success/i,
    defaultEnabled: false,
  },
  {
    key: "user-prompt-submit",
    description: "User prompt submit hook - 'UserPromptSubmit'",
    pattern: /UserPromptSubmit/i,
    defaultEnabled: false,
  },
]

/**
 * Get the list of currently enabled filter patterns.
 * Can be customized via enabledFilterKeys parameter.
 */
export function getEnabledFilters(
  enabledFilterKeys?: Array<string>,
): Array<RegExp> {
  if (enabledFilterKeys) {
    // Use explicitly specified filters
    return SYSTEM_REMINDER_FILTERS.filter((f) =>
      enabledFilterKeys.includes(f.key),
    ).map((f) => f.pattern)
  }
  // Use default enabled filters
  return SYSTEM_REMINDER_FILTERS.filter((f) => f.defaultEnabled).map(
    (f) => f.pattern,
  )
}

// Current enabled patterns (default: only malware/harmful)
let enabledPatterns = getEnabledFilters()

/**
 * Configure which system-reminder filters are enabled.
 * Pass an array of filter keys to enable, or undefined to reset to defaults.
 */
export function configureSystemReminderFilters(
  filterKeys?: Array<string>,
): void {
  enabledPatterns = getEnabledFilters(filterKeys)
}

/**
 * Check if a system-reminder content should be filtered out.
 * Only removes reminders that match currently enabled patterns.
 */
function shouldFilterReminder(content: string): boolean {
  return enabledPatterns.some((pattern) => pattern.test(content))
}

/**
 * Remove specific <system-reminder> tags from text content.
 * Only removes reminders that match enabled filter patterns (default: malware/harmful).
 * Other system-reminders are preserved as they may contain useful context.
 */
export function removeSystemReminderTags(text: string): string {
  return text
    .replaceAll(SYSTEM_REMINDER_PATTERN, (match, content: string) => {
      if (shouldFilterReminder(content)) {
        return "" // Remove this reminder
      }
      return match // Keep this reminder
    })
    .trim()
}

/**
 * Sanitize tool_result content (can be string or array of text/image blocks).
 * Returns the sanitized content and whether it was modified.
 */
function sanitizeToolResultContent(
  content:
    | string
    | Array<
        { type: "text"; text: string } | { type: "image"; source: unknown }
      >,
): { content: typeof content; modified: boolean } {
  if (typeof content === "string") {
    const sanitized = removeSystemReminderTags(content)
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
          acc.blocks.push({ ...block, text: sanitized })
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

/**
 * Remove system-reminder tags from Anthropic message content.
 */
function sanitizeAnthropicMessageContent(
  msg: AnthropicMessage,
): AnthropicMessage {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      return { ...msg, content: sanitized }
    }
    return msg
  }

  // Handle content blocks based on role
  if (msg.role === "user") {
    const result = msg.content.reduce<{
      blocks: Array<AnthropicUserContentBlock>
      modified: boolean
    }>(
      (acc, block) => {
        if (block.type === "text" && typeof block.text === "string") {
          const sanitized = removeSystemReminderTags(block.text)
          if (sanitized !== block.text) {
            acc.blocks.push({ ...block, text: sanitized })
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
          acc.blocks.push({ ...block, text: sanitized })
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
export function removeAnthropicSystemReminders(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  return messages.map((msg) => sanitizeAnthropicMessageContent(msg))
}

/**
 * Remove system-reminder tags from OpenAI message content.
 * Handles both string content and array of content parts.
 *
 * NOTE: Restrictive statement filtering for system prompts is handled by
 * security-research-mode.ts when --security-research-mode is enabled.
 */
function sanitizeOpenAIMessageContent(msg: Message): Message {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      return { ...msg, content: sanitized }
    }
    return msg
  }

  // Handle array of content parts (TextPart | ImagePart)
  if (Array.isArray(msg.content)) {
    const result = msg.content.reduce<{
      parts: Array<
        | { type: "text"; text: string }
        | {
            type: "image_url"
            image_url: { url: string; detail?: "low" | "high" | "auto" }
          }
      >
      modified: boolean
    }>(
      (acc, part) => {
        if (part.type === "text" && typeof part.text === "string") {
          const sanitized = removeSystemReminderTags(part.text)
          if (sanitized !== part.text) {
            acc.parts.push({ ...part, text: sanitized })
            acc.modified = true
            return acc
          }
        }
        acc.parts.push(part)
        return acc
      },
      { parts: [], modified: false },
    )

    if (result.modified) {
      return { ...msg, content: result.parts }
    }
  }

  return msg
}

/**
 * Remove system-reminder tags from all OpenAI messages.
 */
export function removeOpenAISystemReminders(
  messages: Array<Message>,
): Array<Message> {
  return messages.map((msg) => sanitizeOpenAIMessageContent(msg))
}

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
 * Sanitize Anthropic system prompt (can be string or array of text blocks).
 * Only removes system-reminder tags here.
 *
 * NOTE: Restrictive statement filtering is handled separately by:
 * - security-research-mode.ts (when --security-research is enabled)
 * This avoids duplicate processing of the system prompt.
 */
function sanitizeAnthropicSystemPrompt(
  system: string | Array<{ type: "text"; text: string }> | undefined,
): { system: typeof system; modified: boolean } {
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
        acc.blocks.push({ ...block, text: sanitized })
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

/**
 * Sanitize Anthropic messages by filtering orphaned tool blocks and system reminders.
 *
 * @returns Sanitized payload and count of removed items
 */
export function sanitizeAnthropicMessages(payload: AnthropicMessagesPayload): {
  payload: AnthropicMessagesPayload
  removedCount: number
} {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  // Remove system-reminder tags from system prompt
  const { system: sanitizedSystem } = sanitizeAnthropicSystemPrompt(
    payload.system,
  )

  // Remove system-reminder tags from all messages
  messages = removeAnthropicSystemReminders(messages)

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
    payload: { ...payload, system: sanitizedSystem, messages },
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
 * Sanitize OpenAI messages by filtering orphaned tool messages and system reminders.
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

  // Remove system-reminder tags from all messages
  let messages = removeOpenAISystemReminders(conversationMessages)
  const sanitizedSystemMessages = removeOpenAISystemReminders(systemMessages)

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
    payload: {
      ...payload,
      messages: [...sanitizedSystemMessages, ...messages],
    },
    removedCount,
  }
}
