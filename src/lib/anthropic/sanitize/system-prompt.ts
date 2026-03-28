import type { MessagesPayload } from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/system-prompt"

import { sanitizeTextBlocksInArray } from "./text-blocks"

/**
 * Sanitize Anthropic system prompt (can be string or array of text blocks).
 * Only removes system-reminder tags here.
 *
 * NOTE: Restrictive statement filtering is handled separately by:
 * - system-prompt.ts (via config.yaml overrides)
 * This avoids duplicate processing of the system prompt.
 */
export function sanitizeAnthropicSystemPrompt(system: MessagesPayload["system"]): {
  system: MessagesPayload["system"]
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
