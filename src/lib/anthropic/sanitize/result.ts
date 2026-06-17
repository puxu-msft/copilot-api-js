import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"

import {
  //
  countAnthropicContentBlocks,
  filterEmptyAnthropicTextBlocks,
  filterEmptySystemTextBlocks,
} from "./content-blocks"

export interface SanitizationStats {
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  /** Corrupt (unsigned) thinking blocks dropped by the thinking_block_sanitize pass */
  emptyThinkingBlocksRemoved: number
  systemReminderRemovals: number
  /** Inline `role:"system"` messages converted/dropped by system_messages_sanitize (NOT a block-removal count) */
  inlineSystemConverted: number
  totalBlocksRemoved: number
}

export function finalizeAnthropicSanitization(
  payload: MessagesPayload,
  messages: MessagesPayload["messages"],
  system: MessagesPayload["system"],
  originalBlockCount: number,
  toolStats: Pick<SanitizationStats, "fixedNameCount" | "orphanedToolUseCount" | "orphanedToolResultCount">,
  systemReminderRemovals: number,
  inlineSystemConverted: number,
  emptyThinkingBlocksRemoved: number,
): SanitizeResult<MessagesPayload> & { stats: SanitizationStats } {
  // Corrupt thinking blocks were dropped earlier in sanitize.ts (before processToolBlocks)
  // so its empty-message cleanup handles any message left empty by the removal. The count
  // arrives here as a parameter solely for stats / log accounting.
  const finalMessages = filterEmptyAnthropicTextBlocks(messages)
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

  if (inlineSystemConverted > 0) {
    consola.info(`[Sanitizer:Anthropic] Handled ${inlineSystemConverted} inline system message(s) [${state.systemMessagesSanitize}]`)
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
      inlineSystemConverted,
      totalBlocksRemoved,
    },
  }
}

/**
 * Convert {@link SanitizationStats} to the history-facing `SanitizationInfo` shape
 * (drops `inlineSystemConverted`, which is a role-conversion count, not a block
 * removal). Shared by the legacy handler's `runInitialSanitizationAndRecord` and
 * the v4 Anthropic codec so both record the identical sanitization envelope.
 */
export function toSanitizationInfo(stats: SanitizationStats) {
  return {
    totalBlocksRemoved: stats.totalBlocksRemoved,
    orphanedToolUseCount: stats.orphanedToolUseCount,
    orphanedToolResultCount: stats.orphanedToolResultCount,
    fixedNameCount: stats.fixedNameCount,
    emptyTextBlocksRemoved: stats.emptyTextBlocksRemoved,
    emptyThinkingBlocksRemoved: stats.emptyThinkingBlocksRemoved,
    systemReminderRemovals: stats.systemReminderRemovals,
  }
}
