import type {
  AssistantMessage,
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  UserMessage,
} from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/sanitize-system-reminder"

import { isImmutableThinkingAssistantMessage } from "../thinking-immutability"

/**
 * Remove system-reminder tags from text blocks in an array.
 * Drops blocks whose text becomes empty after sanitization.
 * Returns the original array reference if nothing changed (for cheap identity checks).
 */
function sanitizeTextBlocksInArray<T extends { type: string }>(
  blocks: Array<T>,
  getText: (block: T) => string | undefined,
  setText: (block: T, text: string) => T,
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

/**
 * Sanitize tool_result content (can be string or array of text/image blocks).
 * Returns the sanitized content and whether it was modified.
 */
function sanitizeToolResultContent(
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: unknown }>,
): { content: typeof content; modified: boolean } {
  if (typeof content === "string") {
    const sanitized = removeSystemReminderTags(content)
    if (!sanitized && sanitized !== content) {
      return { content, modified: false }
    }
    return { content: sanitized, modified: sanitized !== content }
  }

  const { blocks, modified } = sanitizeTextBlocksInArray(
    content,
    (block) => (block.type === "text" ? block.text : undefined),
    (block, text) => ({ ...block, text }),
  )
  return { content: modified ? blocks : content, modified }
}

/**
 * Remove system-reminder tags from Anthropic message content.
 */
function sanitizeMessageParamContent(msg: MessageParam): MessageParam {
  if (typeof msg.content === "string") {
    const sanitized = removeSystemReminderTags(msg.content)
    if (sanitized !== msg.content) {
      return sanitized ? { ...msg, content: sanitized } : msg
    }
    return msg
  }

  if (msg.role === "user") {
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

  if (isImmutableThinkingAssistantMessage(msg)) {
    return msg
  }

  const { blocks, modified } = sanitizeTextBlocksInArray(
    msg.content,
    (block) => (block.type === "text" && "text" in block ? (block as { text: string }).text : undefined),
    (block, text) => ({ ...block, text }) as ContentBlock,
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
  return { messages: modifiedCount === 0 ? messages : result, modifiedCount }
}
