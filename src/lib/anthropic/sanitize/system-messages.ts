/**
 * Handle `role:"system"` messages mixed into the Anthropic `messages` array.
 *
 * The Anthropic Messages API rejects `role:"system"` inside `messages` with
 * `Unexpected role "system"` — system must be the top-level `system` parameter.
 * Such inline system messages come from OpenAI-habit clients or Claude Code's
 * mid-conversation context injections (hook output / rules / reminders).
 *
 * Driven by `state.systemMessagesSanitize` (config `anthropic.system_messages_sanitize`).
 * The mode is passed in explicitly (not read from state) so this stays a pure,
 * directly-testable function.
 */

import consola from "consola"

import type {
  //
  ContentBlockParam,
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { ensureAnthropicStartsWithUser } from "../auto-truncate/tool-utils"
import { shouldPreserveThinkingBlocks } from "../thinking-protection"

export type SystemMessagesSanitizeMode = false | "drop_invalid" | "merge" | "as_user" | "as_assistant"

/**
 * Extract plain text from an inline system message's content for `merge` mode.
 * System (top-level) can only hold text, so non-text blocks (image, …) cannot be
 * preserved — warn and drop them (observability over silent loss). Returns "" when
 * there is no text.
 */
function extractSystemText(content: MessageParam["content"]): string {
  if (typeof content === "string") return content

  const parts: Array<string> = []
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text)
    } else {
      consola.warn(`[SystemMessages] Dropping non-text block (type=${block.type}) while merging inline system message into top-level system`)
    }
  }
  return parts.join("\n\n")
}

/** Append text to the top-level system param (string / array / undefined). */
function appendToSystem(system: MessagesPayload["system"], text: string): MessagesPayload["system"] {
  if (!text) return system
  if (system === undefined) return text
  if (typeof system === "string") return `${system}\n\n${text}`
  return [...system, { type: "text" as const, text }]
}

/**
 * Whether a message's content carries no usable signal — empty string, empty
 * array, or an array whose blocks are all blank text. An image-only message is
 * NOT empty (images are valid in user/assistant turns). Used by as_user/
 * as_assistant to decide whether a converted message should be dropped instead
 * of shipped as an empty-content message (which the upstream rejects).
 */
function isEffectivelyEmptyContent(content: MessageParam["content"]): boolean {
  if (typeof content === "string") return content.trim() === ""
  if (content.length === 0) return true
  return content.every((block) => block.type === "text" && block.text.trim() === "")
}

/**
 * Merge adjacent same-role messages (mirrors deduplicate-tool-calls.ts) so that
 * a converted system message folds into its neighbour. Never merges into an
 * assistant turn carrying signed thinking blocks (would corrupt the signature).
 */
function mergeAdjacentSameRole(messages: Array<MessageParam>): Array<MessageParam> {
  const merged: Array<MessageParam> = []
  for (const msg of messages) {
    const prev = merged.at(-1)
    if (prev && prev.role === msg.role) {
      if (prev.role === "assistant" && (shouldPreserveThinkingBlocks(prev) || shouldPreserveThinkingBlocks(msg))) {
        merged.push(msg)
        continue
      }

      const prevContent = typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content
      const currContent = typeof msg.content === "string" ? [{ type: "text" as const, text: msg.content }] : msg.content
      merged[merged.length - 1] = {
        ...prev,
        content: [...prevContent, ...currContent] as Array<ContentBlockParam>,
      } as MessageParam
    } else {
      merged.push(msg)
    }
  }
  return merged
}

/**
 * Process inline `role:"system"` messages per the configured mode.
 * Idempotent: once converted/dropped there are no `role:"system"` messages left,
 * so a re-run early-exits.
 */
export function sanitizeInlineSystemMessages(
  messages: Array<MessageParam>,
  system: MessagesPayload["system"],
  mode: SystemMessagesSanitizeMode,
): { messages: Array<MessageParam>; system: MessagesPayload["system"]; convertedCount: number } {
  if (mode === false) return { messages, system, convertedCount: 0 }
  if (!messages.some((msg) => msg.role === "system")) return { messages, system, convertedCount: 0 }

  if (mode === "drop_invalid") {
    const result = messages.filter((msg) => msg.role !== "system")
    return { messages: result, system, convertedCount: messages.length - result.length }
  }

  if (mode === "merge") {
    let newSystem = system
    let convertedCount = 0
    const result: Array<MessageParam> = []
    for (const msg of messages) {
      if (msg.role !== "system") {
        result.push(msg)
        continue
      }
      // Drop from messages regardless; append text only when non-empty.
      const text = extractSystemText(msg.content)
      if (text.trim()) newSystem = appendToSystem(newSystem, text)
      convertedCount++
    }
    return { messages: result, system: newSystem, convertedCount }
  }

  // as_user / as_assistant: rewrite role, drop empty-content ones, then merge neighbours.
  const targetRole = mode === "as_user" ? ("user" as const) : ("assistant" as const)
  let convertedCount = 0
  const rewritten: Array<MessageParam> = []
  for (const msg of messages) {
    if (msg.role !== "system") {
      rewritten.push(msg)
      continue
    }
    convertedCount++
    // Never emit an empty-content message (upstream 400).
    if (isEffectivelyEmptyContent(msg.content)) continue
    rewritten.push({ ...msg, role: targetRole } as MessageParam)
  }

  let result = mergeAdjacentSameRole(rewritten)
  // Converting a leading system→assistant would make messages[0] an illegal
  // (non-user) turn; drop leading illegal messages. as_user never hits this.
  if (mode === "as_assistant") {
    result = ensureAnthropicStartsWithUser(result)
  }
  return { messages: result, system, convertedCount }
}
