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
  UserMessage,
} from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/sanitize-system-reminder"
import { extractLeadingSystemReminderTags, extractTrailingSystemReminderTags } from "~/lib/sanitize-system-reminder"
import { state } from "~/lib/state"
import { isServerToolResultBlock } from "~/types/api/anthropic"

import { hasThinkingSignatureBlocks, isImmutableThinkingAssistantMessage } from "./thinking-immutability"

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

  if (isImmutableThinkingAssistantMessage(msg)) {
    return msg
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
  // Return original array reference when nothing changed (avoids unnecessary allocation)
  return { messages: modifiedCount === 0 ? messages : result, modifiedCount }
}

// ============================================================================
// System Prompt Sanitization
// ============================================================================

/**
 * Sanitize Anthropic system prompt (can be string or array of text blocks).
 * Only removes system-reminder tags here.
 *
 * NOTE: Restrictive statement filtering is handled separately by:
 * - system-prompt.ts (via config.yaml overrides)
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
    if (msg.role === "assistant" && hasThinkingSignatureBlocks(msg)) {
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
      if (isImmutableThinkingAssistantMessage(msg)) {
        result.push(msg)
        continue
      }

      // Process assistant messages: fix tool names and filter orphaned tool_use/server_tool_use.
      // IMPORTANT: Only create a new message object when content is actually modified.
      // Assistant messages may contain thinking/redacted_thinking blocks with signatures
      // that the API validates. Creating a new object (even with identical content) can
      // trigger "thinking blocks cannot be modified" errors after context_management
      // truncation changes which message the API considers the "latest assistant message".
      const newContent: Array<ContentBlockParam> = []
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
          newContent.push(block as ContentBlockParam)
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
// Phase 1: One-time Preprocessing (幂等预处理，路由前执行一次)
// ============================================================================
// These operations are idempotent — once processed, re-running produces no
// further changes. They do NOT need to re-run after auto-truncate retries.
//
// Includes:
//   - deduplicateToolCalls: remove repeated tool_use/tool_result pairs
//   - stripReadToolResultTags: strip injected <system-reminder> from Read results
// ============================================================================

// Dedup Tool Calls
// ----------------------------------------------------------------------------

/**
 * Remove duplicate tool_use/tool_result pairs, keeping only the last occurrence
 * of each matching combination.
 *
 * Claude Code sometimes enters a "read loop" where it repeatedly reads the same
 * files without progressing, causing prompt inflation. This removes redundant
 * earlier calls while preserving the most recent result for each unique call.
 *
 * @param mode - `"input"`: match by (tool_name, input).
 *               `"result"`: match by (tool_name, input, result_content) — only dedup
 *               when the result is also identical.
 *
 * After removal, empty messages are dropped and consecutive same-role messages
 * are merged (Anthropic requires strict user/assistant alternation).
 */
export function deduplicateToolCalls(
  messages: Array<MessageParam>,
  mode: "input" | "result" = "input",
): {
  messages: Array<MessageParam>
  dedupedCount: number
  /** Per-tool breakdown of how many duplicate calls were removed */
  dedupedByTool: Record<string, number>
} {
  // Step 1: Build tool_use name+input map from assistant messages
  // Map: tool_use id → (name, JSON(input)) key (may be extended with result content below)
  const toolUseKeys = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const key = `${block.name}:${JSON.stringify(block.input)}`
        toolUseKeys.set(block.id, key)
      }
    }
  }

  // Step 1.5 ("result" mode): Extend keys with tool_result content.
  // This makes the dedup key (name, input, result) so calls with identical input
  // but different results are NOT considered duplicates.
  if (mode === "result") {
    // Collect tool_result content by tool_use_id
    const resultContentById = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role !== "user" || typeof msg.content === "string") continue
      for (const block of msg.content) {
        if (block.type === "tool_result" && toolUseKeys.has(block.tool_use_id)) {
          const resultStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
          resultContentById.set(block.tool_use_id, resultStr)
        }
      }
    }

    // Extend each tool_use key with its result content
    for (const [id, baseKey] of toolUseKeys) {
      const resultContent = resultContentById.get(id)
      if (resultContent !== undefined) {
        toolUseKeys.set(id, `${baseKey}::${resultContent}`)
      }
    }
  }

  // Step 2: Reverse scan to find the LAST occurrence of each key (the keeper)
  const keeperIds = new Set<string>()
  const seenKeys = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j]
      if (block.type === "tool_use") {
        const key = toolUseKeys.get(block.id)
        if (!key) continue
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          keeperIds.add(block.id)
        }
      }
    }
  }

  // Step 2.5: Protect tool_use IDs in messages with thinking/redacted_thinking blocks.
  // The API validates thinking block signatures against the original response —
  // modifying the content array (even removing an adjacent tool_use) can trigger
  // "thinking blocks cannot be modified" errors.
  const protectedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    const hasThinking = hasThinkingSignatureBlocks(msg)
    if (!hasThinking) continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        protectedIds.add(block.id)
      }
    }
  }

  // Step 3: Forward scan — remove non-keeper tool_use blocks, collect their IDs
  const removedIds = new Set<string>()

  for (const [id, key] of toolUseKeys) {
    // If this ID has a key that was seen (i.e., has duplicates) but is not the keeper,
    // AND is not in a message with thinking blocks (which must not be modified)
    if (seenKeys.has(key) && !keeperIds.has(id) && !protectedIds.has(id)) {
      removedIds.add(id)
    }
  }

  if (removedIds.size === 0) {
    return { messages, dedupedCount: 0, dedupedByTool: {} }
  }

  // Build per-tool breakdown from removed IDs
  const dedupedByTool: Record<string, number> = {}
  for (const id of removedIds) {
    const key = toolUseKeys.get(id)
    if (key) {
      const toolName = key.slice(0, key.indexOf(":"))
      dedupedByTool[toolName] = (dedupedByTool[toolName] ?? 0) + 1
    }
  }

  // Step 4: Filter out removed tool_use and tool_result blocks
  const filtered: Array<MessageParam> = []

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      filtered.push(msg)
      continue
    }

    if (msg.role === "assistant") {
      const newContent = msg.content.filter((block) => block.type !== "tool_use" || !removedIds.has(block.id))
      if (newContent.length > 0) {
        // Preserve original object if nothing removed (thinking block signatures)
        if (newContent.length === msg.content.length) {
          filtered.push(msg)
        } else {
          filtered.push({ ...msg, content: newContent } as MessageParam)
        }
      }
    } else {
      const newContent = msg.content.filter(
        (block) => block.type !== "tool_result" || !removedIds.has(block.tool_use_id),
      )
      if (newContent.length > 0) {
        if (newContent.length === msg.content.length) {
          filtered.push(msg)
        } else {
          filtered.push({ ...msg, content: newContent } as MessageParam)
        }
      }
    }
  }

  // Step 5: Merge consecutive same-role messages (Anthropic requires alternation)
  const merged: Array<MessageParam> = []
  for (const msg of filtered) {
    const prev = merged.at(-1)
    if (prev && prev.role === msg.role) {
      if (prev.role === "assistant" && (isImmutableThinkingAssistantMessage(prev) || isImmutableThinkingAssistantMessage(msg))) {
        merged.push(msg)
        continue
      }

      // Merge content arrays
      const prevContent =
        typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content
      const currContent = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content
      merged[merged.length - 1] = {
        ...prev,
        content: [...prevContent, ...currContent],
      } as MessageParam
    } else {
      merged.push(msg)
    }
  }

  return { messages: merged, dedupedCount: removedIds.size, dedupedByTool }
}

// Strip Read Tool Result Tags
// ----------------------------------------------------------------------------

/**
 * Strip ALL `<system-reminder>` tags from Read tool results.
 *
 * Claude Code injects system-reminder tags (TodoWrite reminders, Plan mode
 * reminders, etc.) into every tool_result. For Read tool results, these tags
 * are pure noise — they repeat every time the same file is read and inflate
 * context by 7-14%.
 *
 * Unlike the main `removeSystemReminderTags` (which only removes tags matching
 * enabled filters), this function removes ALL system-reminder tags regardless
 * of content, since Read results should contain only file content.
 */
export function stripReadToolResultTags(messages: Array<MessageParam>): {
  messages: Array<MessageParam>
  strippedCount: number
  tagPreviews: Array<string>
} {
  // Step 1: Collect all Read tool_use IDs
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

  // Step 2: Strip tags from matching tool_result blocks
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

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `modified` is set inside .map() callback
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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `modified` is set inside .map() callback
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

  // Extract trailing tags
  const trailing = extractTrailingSystemReminderTags(text)
  tagCount += trailing.tags.length
  for (const tag of trailing.tags) {
    tagPreviews.push(tag.content.slice(0, 80))
  }

  // Extract leading tags from the remaining content
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

// Preprocess Orchestrator
// ----------------------------------------------------------------------------

/**
 * One-time preprocessing of Anthropic messages.
 *
 * Runs idempotent operations that reduce context noise before the request
 * enters the routing / retry pipeline. These do NOT need to re-run after
 * auto-truncate retries because truncation cannot introduce new duplicates
 * or new system-reminder tags.
 */
export function preprocessAnthropicMessages(messages: Array<MessageParam>): {
  messages: Array<MessageParam>
  strippedReadTagCount: number
  dedupedToolCallCount: number
} {
  let result = messages
  let strippedReadTagCount = 0
  let dedupedToolCallCount = 0

  // Strip injected <system-reminder> tags from Read tool results
  if (state.stripReadToolResultTags) {
    const strip = stripReadToolResultTags(result)
    result = strip.messages
    strippedReadTagCount = strip.strippedCount
    if (strippedReadTagCount > 0) {
      consola.info(
        `[Preprocess] Stripped ${strippedReadTagCount} system-reminder tags from Read results:\n`
          + strip.tagPreviews.map((p) => `  - "${p}${p.length >= 80 ? "…" : ""}"`).join("\n"),
      )
    }
  }

  // Deduplicate repeated tool_use/tool_result pairs (keep last occurrence)
  if (state.dedupToolCalls) {
    const dedup = deduplicateToolCalls(result, state.dedupToolCalls)
    result = dedup.messages
    dedupedToolCallCount = dedup.dedupedCount
    if (dedupedToolCallCount > 0) {
      const breakdown = Object.entries(dedup.dedupedByTool)
        .map(([name, count]) => `${name}×${count}`)
        .join(", ")
      consola.info(`[Preprocess] Deduped ${dedupedToolCallCount} tool calls [${state.dedupToolCalls}] (${breakdown})`)
    }
  }

  return { messages: result, strippedReadTagCount, dedupedToolCallCount }
}

// ============================================================================
// Phase 2: Repeatable Sanitization (可重复清洗，truncate 后需重新执行)
// ============================================================================
// These operations must re-run after every auto-truncate retry because
// truncation can break tool_use/tool_result pairing and produce empty blocks.
//
// Includes:
//   - sanitizeAnthropicSystemPrompt: clean system prompt system-reminders
//   - removeAnthropicSystemReminders: clean message system-reminders
//   - processToolBlocks: fix tool names + filter orphaned tool blocks
//   - filterEmptyAnthropicTextBlocks: safety net for empty text blocks
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
    blocksRemoved: totalBlocksRemoved,
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
