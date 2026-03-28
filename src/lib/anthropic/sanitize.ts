/**
 * Anthropic message sanitization orchestrator.
 *
 * Keeps the public import surface stable while the concrete sanitizers live in
 * focused submodules under `anthropic/sanitize/`.
 */

import consola from "consola"

import type { MessageParam, MessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"

import { countAnthropicContentBlocks } from "./sanitize/content-blocks"
import { deduplicateToolCalls } from "./sanitize/deduplicate-tool-calls"
import { stripReadToolResultTags } from "./sanitize/read-tool-result-tags"
import { finalizeAnthropicSanitization, type SanitizationStats } from "./sanitize/result"
import { removeAnthropicSystemReminders } from "./sanitize/system-reminders"
import { sanitizeAnthropicSystemPrompt } from "./sanitize/system-prompt"
import { processToolBlocks } from "./sanitize/tool-blocks"

export {
  deduplicateToolCalls,
  processToolBlocks,
  removeAnthropicSystemReminders,
  type SanitizationStats,
  stripReadToolResultTags,
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
 * Sanitize Anthropic messages by filtering orphaned tool blocks and system reminders.
 */
export function sanitizeAnthropicMessages(
  payload: MessagesPayload,
): ReturnType<typeof finalizeAnthropicSanitization> {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  const { system: sanitizedSystem } = sanitizeAnthropicSystemPrompt(payload.system)

  const reminderResult = removeAnthropicSystemReminders(messages)
  messages = reminderResult.messages
  const systemReminderRemovals = reminderResult.modifiedCount

  const toolResult = processToolBlocks(messages, payload.tools)
  messages = toolResult.messages
  return finalizeAnthropicSanitization(payload, messages, sanitizedSystem, originalBlocks, toolResult, systemReminderRemovals)
}
