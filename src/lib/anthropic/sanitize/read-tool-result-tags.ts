import type { ContentBlockParam, MessageParam, UserMessage } from "~/types/api/anthropic"

import { extractLeadingSystemReminderTags, extractTrailingSystemReminderTags } from "~/lib/sanitize-system-reminder"

/**
 * Strip ALL `<system-reminder>` tags from Read tool results.
 */
export function stripReadToolResultTags(messages: Array<MessageParam>): {
  messages: Array<MessageParam>
  strippedCount: number
  tagPreviews: Array<string>
} {
  const readToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "Read") {
        readToolUseIds.add(block.id)
      }
    }
  }

  if (readToolUseIds.size === 0) {
    return { messages, strippedCount: 0, tagPreviews: [] }
  }

  let strippedCount = 0
  const allPreviews: Array<string> = []
  const result = messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg

    let modified = false
    const newContent = msg.content.map((block) => {
      if (block.type !== "tool_result" || !readToolUseIds.has(block.tool_use_id)) {
        return block
      }

      const stripped = stripAllSystemReminderTags(block.content as string | Array<{ type: string; text?: string }>)
      if (stripped.modified) {
        modified = true
        strippedCount += stripped.tagCount
        allPreviews.push(...stripped.tagPreviews)
        return { ...block, content: stripped.content } as ContentBlockParam
      }
      return block
    })

    return modified ? ({ ...msg, content: newContent } as UserMessage) : msg
  })

  return { messages: strippedCount > 0 ? result : messages, strippedCount, tagPreviews: allPreviews }
}

/**
 * Strip ALL system-reminder tags from tool_result content (string or array form).
 * Returns the cleaned content and whether anything was modified.
 */
function stripAllSystemReminderTags(content: string | Array<{ type: string; text?: string }>): {
  content: typeof content
  modified: boolean
  tagCount: number
  tagPreviews: Array<string>
} {
  if (typeof content === "string") {
    return stripAllTagsFromString(content)
  }

  let totalTagCount = 0
  const allPreviews: Array<string> = []
  let modified = false
  const result = content.map((block) => {
    if (block.type !== "text" || !block.text) return block
    const stripped = stripAllTagsFromString(block.text)
    if (stripped.modified) {
      modified = true
      totalTagCount += stripped.tagCount
      allPreviews.push(...stripped.tagPreviews)
      return { ...block, text: stripped.content }
    }
    return block
  })

  return { content: modified ? result : content, modified, tagCount: totalTagCount, tagPreviews: allPreviews }
}

/**
 * Remove ALL system-reminder tags from a string, keeping only the main content.
 */
function stripAllTagsFromString(text: string): {
  content: string
  modified: boolean
  tagCount: number
  tagPreviews: Array<string>
} {
  let tagCount = 0
  const tagPreviews: Array<string> = []

  const trailing = extractTrailingSystemReminderTags(text)
  tagCount += trailing.tags.length
  for (const tag of trailing.tags) {
    tagPreviews.push(tag.content.slice(0, 80))
  }

  const mainSlice = text.slice(0, trailing.mainContentEnd)
  const leading = extractLeadingSystemReminderTags(mainSlice)
  tagCount += leading.tags.length
  for (const tag of leading.tags) {
    tagPreviews.push(tag.content.slice(0, 80))
  }

  if (tagCount === 0) {
    return { content: text, modified: false, tagCount: 0, tagPreviews: [] }
  }

  const content = mainSlice.slice(leading.mainContentStart)
  return { content, modified: true, tagCount, tagPreviews }
}
