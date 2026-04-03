import type { ContentBlockParam, MessageParam } from "~/types/api/anthropic"

import { isServerToolResultBlock } from "~/types/api/anthropic"

import { isImmutableThinkingAssistantMessage } from "../thinking-immutability"

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
  const nameMap = new Map<string, string>()
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      nameMap.set(tool.name.toLowerCase(), tool.name)
    }
  }

  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === "string") continue

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if ((block.type === "tool_use" || block.type === "server_tool_use") && block.id) {
          toolUseIds.add(block.id)
        }
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

  const result: Array<MessageParam> = []
  let fixedNameCount = 0
  let orphanedToolUseCount = 0
  let orphanedToolResultCount = 0
  const filteredToolUseIds = new Set<string>()

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push(msg)
      continue
    }

    if (msg.role === "assistant") {
      if (isImmutableThinkingAssistantMessage(msg)) {
        result.push(msg)
        continue
      }

      const newContent: Array<ContentBlockParam> = []
      let modified = false

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          if (!toolResultIds.has(block.id)) {
            orphanedToolUseCount++
            filteredToolUseIds.add(block.id)
            modified = true
            continue
          }

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
          if (!toolResultIds.has(block.id)) {
            orphanedToolUseCount++
            filteredToolUseIds.add(block.id)
            modified = true
            continue
          }

          if (typeof block.input === "string") {
            modified = true
            newContent.push({ ...block, input: parseStringifiedInput(block.input) })
          } else {
            newContent.push(block)
          }
        } else {
          if (
            isServerToolResultBlock(block)
            && (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id))
          ) {
            orphanedToolResultCount++
            modified = true
            continue
          }
          newContent.push(block as ContentBlockParam)
        }
      }

      if (newContent.length === 0) continue
      result.push(modified ? { ...msg, content: newContent } : msg)
    } else {
      const newContent: Array<ContentBlockParam> = []

      for (const block of msg.content) {
        if (block.type === "tool_result") {
          if (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id)) {
            orphanedToolResultCount++
            continue
          }
        } else if (isServerToolResultBlock(block)) {
          if (!toolUseIds.has(block.tool_use_id) || filteredToolUseIds.has(block.tool_use_id)) {
            orphanedToolResultCount++
            continue
          }
        } else if (
          (block as unknown as Record<string, unknown>).type !== "text"
          && (block as unknown as Record<string, unknown>).type !== "image"
          && (block as unknown as Record<string, unknown>).type !== "document"
        ) {
          orphanedToolResultCount++
          continue
        }
        newContent.push(block)
      }

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
