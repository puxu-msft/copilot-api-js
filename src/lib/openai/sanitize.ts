/**
 * OpenAI message sanitization orchestrator.
 *
 * Combines system-reminder removal, orphan filtering, and empty block cleanup
 * into a single sanitization pipeline for OpenAI messages.
 */

import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { ChatCompletionsPayload, Message } from "~/types/api/openai-chat-completions"

import { removeSystemReminderTags } from "~/lib/system-prompt"

import {
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
} from "./orphan-filter"

// ============================================================================
// Message Content Sanitization
// ============================================================================

/**
 * Remove system-reminder tags from OpenAI message content.
 * Handles both string content and array of content parts.
 *
 * NOTE: System prompt overrides are handled by
 * system-prompt.ts via config.yaml.
 */
function sanitizeOpenAIMessageContent(msg: Message): Message {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      // Don't return empty content — keep original if sanitized is empty
      return sanitized ? { ...msg, content: sanitized } : msg
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
            if (sanitized) {
              acc.parts.push({ ...part, text: sanitized })
            }
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
export function removeOpenAISystemReminders(messages: Array<Message>): {
  messages: Array<Message>
  modifiedCount: number
} {
  let modifiedCount = 0
  const result = messages.map((msg) => {
    const sanitized = sanitizeOpenAIMessageContent(msg)
    if (sanitized !== msg) modifiedCount++
    return sanitized
  })
  return { messages: result, modifiedCount }
}

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Sanitize OpenAI messages by filtering orphaned tool messages and system reminders.
 *
 * @returns Sanitized payload and count of removed items
 */
export function sanitizeOpenAIMessages(payload: ChatCompletionsPayload): SanitizeResult<ChatCompletionsPayload> {
  const { systemMessages, conversationMessages } = extractOpenAISystemMessages(payload.messages)

  // Remove system-reminder tags from all messages
  const convResult = removeOpenAISystemReminders(conversationMessages)
  let messages = convResult.messages
  const sysResult = removeOpenAISystemReminders(systemMessages)
  const sanitizedSystemMessages = sysResult.messages
  const systemReminderRemovals = convResult.modifiedCount + sysResult.modifiedCount

  const originalCount = messages.length

  // Filter orphaned tool_result and tool_use messages
  messages = filterOpenAIOrphanedToolResults(messages)
  messages = filterOpenAIOrphanedToolUse(messages)

  // Final safety net: remove empty/whitespace-only text parts from array content
  const allMessages = [...sanitizedSystemMessages, ...messages].map((msg) => {
    if (!Array.isArray(msg.content)) return msg
    const filtered = msg.content.filter((part) => {
      if (part.type === "text") return part.text.trim() !== ""
      return true
    })
    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered }
  })

  const blocksRemoved = originalCount - messages.length

  if (blocksRemoved > 0) {
    consola.info(`[Sanitizer:OpenAI] Filtered ${blocksRemoved} orphaned tool messages`)
  }

  return {
    payload: {
      ...payload,
      messages: allMessages,
    },
    blocksRemoved,
    systemReminderRemovals,
  }
}
