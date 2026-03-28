/**
 * Anthropic message sanitization orchestrator.
 *
 * Keeps the public import surface stable while the concrete sanitizers live in
 * focused submodules under `anthropic/sanitize/`.
 */

import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { MessageParam, MessagesPayload } from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/sanitize-system-reminder"
import { state } from "~/lib/state"

import { deduplicateToolCalls } from "./sanitize/deduplicate-tool-calls"
import { stripReadToolResultTags } from "./sanitize/read-tool-result-tags"
import { removeAnthropicSystemReminders } from "./sanitize/system-reminders"
import { processToolBlocks } from "./sanitize/tool-blocks"
import { hasThinkingSignatureBlocks } from "./thinking-immutability"

export {
  deduplicateToolCalls,
  processToolBlocks,
  removeAnthropicSystemReminders,
  stripReadToolResultTags,
}

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
    (block) => block.text,
    (block, text) => ({ ...block, text }),
  )
  return { system: modified ? blocks : system, modified }
}

/**
 * Final pass: remove any empty/whitespace-only text content blocks from Anthropic messages.
 * This is a safety net that catches empty blocks regardless of how they were produced.
 */
function filterEmptyAnthropicTextBlocks(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

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

/**
 * Remove system-reminder tags from text blocks in an array.
 * Drops blocks whose text becomes empty after sanitization.
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
 * One-time preprocessing of Anthropic messages.
 *
 * Runs idempotent operations that reduce context noise before the request
 * enters the routing / retry pipeline.
 */
export function preprocessAnthropicMessages(messages: Array<MessageParam>): {
  messages: Array<MessageParam>
  strippedReadTagCount: number
  dedupedToolCallCount: number
} {
  let result = messages
  let strippedReadTagCount = 0
  let dedupedToolCallCount = 0

  if (state.stripReadToolResultTags) {
    const strip = stripReadToolResultTags(result)
    result = strip.messages
    strippedReadTagCount = strip.strippedCount
    if (strippedReadTagCount > 0) {
      consola.info(
        `[Preprocess] Stripped ${strippedReadTagCount} system-reminder tags from Read results:\n`
          + strip.tagPreviews.map((preview) => `  - "${preview}${preview.length >= 80 ? "…" : ""}"`).join("\n"),
      )
    }
  }

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
 */
export function sanitizeAnthropicMessages(
  payload: MessagesPayload,
): SanitizeResult<MessagesPayload> & { stats: SanitizationStats } {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  const { system: sanitizedSystem } = sanitizeAnthropicSystemPrompt(payload.system)

  const reminderResult = removeAnthropicSystemReminders(messages)
  messages = reminderResult.messages
  const systemReminderRemovals = reminderResult.modifiedCount

  const toolResult = processToolBlocks(messages, payload.tools)
  messages = toolResult.messages

  if (toolResult.fixedNameCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Fixed ${toolResult.fixedNameCount} tool name casing mismatches`)
  }

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
