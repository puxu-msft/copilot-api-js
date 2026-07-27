/**
 * Anthropic message sanitization orchestrator.
 *
 * Keeps the public import surface stable while the concrete sanitizers live in
 * focused submodules under `anthropic/sanitize/`.
 */

import consola from "consola"

import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { state } from "~/lib/state"

import { resolveServerToolMode } from "../server-tool-rewrite-mode"
import { resolveSystemSanitizeMode } from "../system-reject-mode"
import { repairAssistantBlockLayout } from "./assistant-block-layout"
import {
  //
  countAnthropicContentBlocks,
  filterEmptyThinkingBlocks,
  stripSyntheticReasoningBlocks,
} from "./content-blocks"
import { deduplicateToolCalls } from "./deduplicate-tool-calls"
import { downgradeEmptyEncryptedSearchResults } from "./empty-encrypted-search-result"
import { stripReadToolResultTags } from "./read-tool-result-tags"
import { finalizeAnthropicSanitization } from "./result"
import { rewriteServerToolBlocks } from "./rewrite-server-tool-blocks"
import { sanitizeInlineSystemMessages } from "./system-messages"
import { sanitizeAnthropicSystemPrompt } from "./system-prompt"
import { removeAnthropicSystemReminders } from "./system-reminders"
import { processToolBlocks } from "./tool-blocks"

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
export function sanitizeAnthropicMessages(payload: MessagesPayload): ReturnType<typeof finalizeAnthropicSanitization> {
  let messages = payload.messages
  const originalBlocks = countAnthropicContentBlocks(messages)

  const { system: sanitizedSystem } = sanitizeAnthropicSystemPrompt(payload.system, state.stripAttributionHeader)

  const reminderResult = removeAnthropicSystemReminders(messages)
  messages = reminderResult.messages
  const systemReminderRemovals = reminderResult.modifiedCount

  // Handle inline `role:"system"` messages (rejected by STRICT upstream backends,
  // e.g. sonnet-4.6/haiku-4.5; accepted by others like Opus) AFTER
  // reminder stripping, so reminders are cleaned in their original system form
  // first. May rewrite messages and/or fold text into the top-level system.
  // Discount any content blocks the inline-system step removes (merge/drop) from
  // the original baseline so `totalBlocksRemoved` reflects only genuine block
  // cleanup (orphan tool / empty text / corrupt thinking) — inline-system moves
  // are reported separately via `inlineSystemConverted`, not as removed blocks.
  const beforeInlineBlocks = countAnthropicContentBlocks(messages)
  const inlineSystem = sanitizeInlineSystemMessages(messages, sanitizedSystem, resolveSystemSanitizeMode(payload.model))
  messages = inlineSystem.messages
  const inlineBlocksRemoved = beforeInlineBlocks - countAnthropicContentBlocks(messages)

  // Downgrade native server-tool blocks left in prior turns by the web_search
  // double-hop (server_tool_use{web_search} + *_tool_result) into plain
  // tool_use + tool_result. MUST run BEFORE processToolBlocks so the tool
  // reference validation sees the already-downgraded (plain) blocks. No-op when
  // disabled. See rewrite-server-tool-blocks.ts for the self-poisoning loop.
  messages = rewriteServerToolBlocks(messages, resolveServerToolMode(payload.model)).messages

  // Fallback (always-on): downgrade any synthesized web_search turn whose result
  // `encrypted_content` is empty/missing — upstream rejects it with "Invalid
  // encrypted_content in search_result block" and there is no valid value we can
  // supply (empirically, even a non-empty placeholder is rejected). Runs AFTER
  // the config-driven downgrade (which, when enabled, already removed all
  // prior-turn server-tool blocks so this is a no-op) and narrowly targets only the
  // proven-broken shape. See empty-encrypted-search-result.ts.
  messages = downgradeEmptyEncryptedSearchResults(messages).messages

  // Strip OUR synthetic-reasoning thinking blocks (sentinel-signed GPT-reasoning forwards) FIRST and
  // UNCONDITIONALLY — a client echoing one back onto the direct Claude leg would 400 upstream with our
  // unforgeable signature. This is a self-owned poison guard, NOT gated by thinkingBlockSanitizeCheck.
  messages = stripSyntheticReasoningBlocks(messages)

  // Drop corrupt (unsigned) thinking blocks BEFORE processToolBlocks so its existing
  // empty-message cleanup (content.length === 0 → drop the whole message) handles any
  // message left empty after corrupt-block removal — no extra drop logic needed, no
  // adjacent same-role risk introduced beyond what processToolBlocks already produces.
  // Validity is decided by the SIGNATURE (see filterEmptyThinkingBlocks); a legitimate
  // encrypted thinking block has empty `thinking` text but a valid `signature` and is
  // kept. Gated by `thinkingBlockSanitizeCheck` (off / all_empty / signature_empty /
  // thinking_empty / any_empty — the mode names WHICH empty field triggers the drop).
  const sanitizeCheck = state.thinkingBlockSanitizeCheck
  const beforeThinkingBlocks = countAnthropicContentBlocks(messages)
  if (sanitizeCheck !== false) {
    messages = filterEmptyThinkingBlocks(messages, sanitizeCheck)
  }
  const emptyThinkingBlocksRemoved = Math.max(0, beforeThinkingBlocks - countAnthropicContentBlocks(messages))

  const toolResult = processToolBlocks(messages, payload.tools)
  messages = toolResult.messages

  const finalized = finalizeAnthropicSanitization(
    payload,
    messages,
    inlineSystem.system,
    originalBlocks - inlineBlocksRemoved,
    toolResult,
    systemReminderRemovals,
    inlineSystem.convertedCount,
    emptyThinkingBlocksRemoved,
  )

  // TERMINAL pass (spec §3.1 / plan review #04 CRITICAL): the assistant block-layout
  // repair runs AFTER processToolBlocks AND finalize's `filterEmptyAnthropicTextBlocks`, so
  // (a) no later pass can delete its synthetic separators (as orphan tool_use / empty
  // text) and (b) it CATCHES violations newly created by orphan-tool deletion. It
  // operates on the finalized messages (`.payload.messages` — there is NO top-level
  // `.messages`) and writes the result back there. Its insert/reorder counters are
  // attached SEPARATELY (`stats.blockLayout`) from finalize's subtractive residual model,
  // which assumes blocks only ever decrease — the layout repair INSERTS.
  const layoutRepair = repairAssistantBlockLayout(finalized.payload.messages, state.assistantBlockLayoutStrategy)
  return {
    ...finalized,
    payload: { ...finalized.payload, messages: layoutRepair.messages },
    stats: { ...finalized.stats, blockLayout: layoutRepair.stats },
  }
}

export { deduplicateToolCalls } from "./deduplicate-tool-calls"

export { stripReadToolResultTags } from "./read-tool-result-tags"
export { layoutRepairActed, type SanitizationStats, toSanitizationInfo } from "./result"
export { removeAnthropicSystemReminders } from "./system-reminders"
export { processToolBlocks } from "./tool-blocks"
