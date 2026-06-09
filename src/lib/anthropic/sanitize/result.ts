import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"

import {
  //
  countAnthropicContentBlocks,
  filterEmptyAnthropicTextBlocks,
  filterEmptySystemTextBlocks,
  filterEmptyThinkingBlocks,
} from "./content-blocks"

export interface SanitizationStats {
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  /** Corrupt (unsigned) thinking blocks dropped by the thinking_block_sanitize_check pass */
  emptyThinkingBlocksRemoved: number
  systemReminderRemovals: number
  totalBlocksRemoved: number
}

export function finalizeAnthropicSanitization(
  payload: MessagesPayload,
  messages: MessagesPayload["messages"],
  system: MessagesPayload["system"],
  originalBlockCount: number,
  toolStats: Pick<SanitizationStats, "fixedNameCount" | "orphanedToolUseCount" | "orphanedToolResultCount">,
  systemReminderRemovals: number,
): SanitizeResult<MessagesPayload> & { stats: SanitizationStats } {
  // Drop corrupt thinking blocks before the upstream rejects the whole request.
  // Validity is decided by the SIGNATURE, not the (often legitimately empty)
  // thinking text — see filterEmptyThinkingBlocks. "empty_thinking" removes only
  // double-empty blocks; "empty_any" removes any unsigned thinking block.
  const sanitizeCheck = state.thinkingBlockSanitizeCheck
  const thinkingChecked = sanitizeCheck === "empty_thinking" || sanitizeCheck === "empty_any" ? filterEmptyThinkingBlocks(messages, sanitizeCheck) : messages
  // Count thinking removals separately so they are not mislabeled as empty-text removals below.
  const emptyThinkingBlocksRemoved =
    thinkingChecked === messages ? 0 : Math.max(0, countAnthropicContentBlocks(messages) - countAnthropicContentBlocks(thinkingChecked))
  const finalMessages = filterEmptyAnthropicTextBlocks(thinkingChecked)
  const finalSystem = filterEmptySystemTextBlocks(system)
  const totalBlocksRemoved = Math.max(0, originalBlockCount - countAnthropicContentBlocks(finalMessages))
  const emptyTextBlocksRemoved = Math.max(
    0,
    totalBlocksRemoved - toolStats.orphanedToolUseCount - toolStats.orphanedToolResultCount - emptyThinkingBlocksRemoved,
  )

  if (toolStats.fixedNameCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Fixed ${toolStats.fixedNameCount} tool name casing mismatches`)
  }

  if (totalBlocksRemoved > 0 && (toolStats.orphanedToolUseCount > 0 || toolStats.orphanedToolResultCount > 0 || emptyThinkingBlocksRemoved > 0)) {
    const parts: Array<string> = []
    if (toolStats.orphanedToolUseCount > 0) parts.push(`${toolStats.orphanedToolUseCount} orphaned tool_use`)
    if (toolStats.orphanedToolResultCount > 0) parts.push(`${toolStats.orphanedToolResultCount} orphaned tool_result`)
    if (emptyThinkingBlocksRemoved > 0) parts.push(`${emptyThinkingBlocksRemoved} corrupt thinking`)
    if (emptyTextBlocksRemoved > 0) parts.push(`${emptyTextBlocksRemoved} empty text blocks`)
    consola.info(`[Sanitizer:Anthropic] Removed ${totalBlocksRemoved} content blocks (${parts.join(", ")})`)
  }

  return {
    payload: { ...payload, system: finalSystem, messages: finalMessages },
    blocksRemoved: totalBlocksRemoved,
    systemReminderRemovals,
    stats: {
      ...toolStats,
      emptyTextBlocksRemoved,
      emptyThinkingBlocksRemoved,
      systemReminderRemovals,
      totalBlocksRemoved,
    },
  }
}
