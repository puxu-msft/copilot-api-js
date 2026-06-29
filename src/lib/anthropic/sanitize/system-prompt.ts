import type {
  //
  MessagesPayload,
  TextBlockParam,
} from "~/types/api/anthropic"

import { removeSystemReminderTags } from "~/lib/system-prompt"

import { sanitizeTextBlocksInArray } from "./text-blocks"

/**
 * Matches a single leading line that IS an `x-anthropic-billing-header:` line.
 * Anchored to the START (`^`, no `m` flag — only the first line), case-insensitive,
 * tolerant of CRLF. NOTE: the anchor is deliberate — the literal string
 * `x-anthropic-billing-header` legitimately appears in prose (this project's own
 * docs / conversation), so a global match would corrupt real content.
 */
const ATTRIBUTION_BILLING_LINE = /^x-anthropic-billing-header\s*:[^\n]*\n?/i

/**
 * Strip leading `x-anthropic-billing-header: …` line(s) from the head of a text.
 *
 * Current Claude Code injects its attribution as the first `system` block (a line
 * formatted like an HTTP header but carried in the request BODY). The HTTP-header
 * strip (`anthropic.strip_request_headers`) cannot reach a body field, so this
 * removes the leading billing line(s) instead. Only consumes consecutive matches
 * at the very start; anything past the first non-billing line is untouched.
 */
export function stripAttributionBillingLine(text: string): { text: string; stripped: boolean } {
  let result = text
  let stripped = false
  while (ATTRIBUTION_BILLING_LINE.test(result)) {
    result = result.replace(ATTRIBUTION_BILLING_LINE, "")
    stripped = true
  }
  return { text: result, stripped }
}

/**
 * Apply the attribution-billing strip to a whole system param (string or array),
 * dispatching the string/array forms. Attribution-only — does NOT touch
 * system-reminder tags. Shared by `sanitizeAnthropicSystemPrompt` (request path)
 * and the count_tokens path so both treat the leading billing line consistently.
 * No-op (returns the same reference) when `enabled` is false or nothing matches.
 */
export function stripSystemAttribution(system: MessagesPayload["system"], enabled: boolean): { system: MessagesPayload["system"]; modified: boolean } {
  if (!enabled || !system) return { system, modified: false }

  if (typeof system === "string") {
    const { text, stripped } = stripAttributionBillingLine(system)
    return { system: stripped ? text : system, modified: stripped }
  }

  // Array form — only the LEADING block (system[0]): Claude Code injects
  // attribution as a dedicated first block, while real prompts / user content
  // live in later blocks / messages.
  if (system.length === 0 || typeof system[0]?.text !== "string") {
    return { system, modified: false }
  }
  const { text, stripped } = stripAttributionBillingLine(system[0].text)
  if (!stripped) return { system, modified: false }

  const head: TextBlockParam = { ...system[0], text }
  // Drop the leading block entirely when nothing meaningful remains.
  const next = head.text.trim() === "" ? system.slice(1) : [head, ...system.slice(1)]
  return { system: next, modified: true }
}

/**
 * Sanitize Anthropic system prompt (can be string or array of text blocks).
 * Removes system-reminder tags, and — when `stripAttribution` is true — strips a
 * leading Claude Code attribution billing line from the head of the system param
 * (the string itself, or `system[0]`'s text). A block emptied by the strip is dropped.
 *
 * NOTE: Restrictive statement filtering is handled separately by:
 * - system-prompt.ts (via config.yaml overrides)
 * This avoids duplicate processing of the system prompt.
 */
export function sanitizeAnthropicSystemPrompt(
  system: MessagesPayload["system"],
  stripAttribution: boolean,
): {
  system: MessagesPayload["system"]
  modified: boolean
} {
  if (!system) {
    return { system, modified: false }
  }

  const attribution = stripSystemAttribution(system, stripAttribution)
  const working = attribution.system

  if (typeof working === "string") {
    const sanitized = removeSystemReminderTags(working)
    const modified = attribution.modified || sanitized !== working
    return { system: modified ? sanitized : system, modified }
  }

  const { blocks, modified: reminderModified } = sanitizeTextBlocksInArray(
    working ?? [],
    (block) => block.text,
    (block, text) => ({ ...block, text }),
  )

  const modified = attribution.modified || reminderModified
  return { system: modified ? blocks : system, modified }
}
