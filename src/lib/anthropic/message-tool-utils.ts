import consola from "consola"

import type { MessageParam } from "~/types/api/anthropic"

import {
  //
  isServerToolResultBlock,
  isToolResultBlock,
} from "~/types/api/anthropic"

/**
 * Whether a message is a LEGAL first message for an Anthropic request.
 *
 * Anthropic requires `messages[0]` to be a user message, and rejects a user
 * message whose content is only tool_result blocks at index 0 (a "tool result
 * turn" with no preceding tool_use — its tool_use was truncated away, so the
 * tool_result is orphaned). Truncation can land the preserve boundary on such a
 * turn, so callers skip leading messages until this returns true.
 *
 * Legal: a user message with string content, or array content containing at
 * least one non-tool_result block (text / image / …). A mixed
 * user[tool_result, text] is legal (kept) — only a PURE tool_result turn is not.
 */
export function isLegalLeadingUserMessage(msg: MessageParam): boolean {
  if (msg.role !== "user") return false
  if (typeof msg.content === "string") return true
  if (msg.content.length === 0) return false
  // Legal iff at least one block is NOT a tool_result (regular or server).
  return msg.content.some((block) => !isToolResultBlock(block) && !isServerToolResultBlock(block))
}

/**
 * Ensure Anthropic messages start with a LEGAL first user message.
 * Drops leading messages that can't be `messages[0]`: non-user messages
 * (e.g. orphaned assistant after truncation) AND pure-tool_result user turns
 * (orphaned tool results whose tool_use was truncated away).
 */
export function ensureAnthropicStartsWithUser(messages: Array<MessageParam>): Array<MessageParam> {
  let startIndex = 0
  while (startIndex < messages.length && !isLegalLeadingUserMessage(messages[startIndex])) {
    startIndex++
  }

  if (startIndex > 0) {
    consola.debug(`[AutoTruncate:Anthropic] Skipped ${startIndex} leading non-startable messages`)
  }

  return messages.slice(startIndex)
}
