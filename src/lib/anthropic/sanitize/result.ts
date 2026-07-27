import consola from "consola"

import type { SanitizationInfo } from "~/lib/history/types"
import type { SanitizeResult } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"

import type { BlockLayoutRepairStats } from "./assistant-block-layout"

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
  /** Inline `role:"system"` messages converted/dropped by system_default_mode (NOT a block-removal count) */
  inlineSystemConverted: number
  totalBlocksRemoved: number
  /**
   * Terminal de-stack pass counters (adjacent-thinking separation). PURE
   * INSERT/reorder — deliberately kept OUT of the subtractive `totalBlocksRemoved`
   * residual model (which assumes blocks only ever decrease). Absent when de-stack
   * was a no-op / disabled (`passthrough`).
   */
  blockLayout?: BlockLayoutRepairStats
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

  if (
    totalBlocksRemoved > 0
    && (toolStats.orphanedToolUseCount > 0 || toolStats.orphanedToolResultCount > 0 || emptyThinkingBlocksRemoved > 0 || emptyTextBlocksRemoved > 0)
  ) {
    const parts: Array<string> = []
    if (toolStats.orphanedToolUseCount > 0) parts.push(`${toolStats.orphanedToolUseCount} orphaned tool_use`)
    if (toolStats.orphanedToolResultCount > 0) parts.push(`${toolStats.orphanedToolResultCount} orphaned tool_result`)
    if (emptyThinkingBlocksRemoved > 0) parts.push(`${emptyThinkingBlocksRemoved} corrupt thinking`)
    if (emptyTextBlocksRemoved > 0) parts.push(`${emptyTextBlocksRemoved} empty text blocks`)
    consola.info(`[Sanitizer:Anthropic] Removed ${totalBlocksRemoved} content blocks (${parts.join(", ")})`)
  }

  if (inlineSystemConverted > 0) {
    consola.info(`[Sanitizer:Anthropic] Handled ${inlineSystemConverted} inline system message(s) [${state.systemDefaultMode}]`)
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
 * Whether the terminal de-stack pass actually acted. De-stack is PURE INSERTION
 * (0 removals), so it is invisible to the subtractive block-removal counters — this
 * is the shared primitive every "did sanitization change anything worth recording?"
 * gate must OR in, so de-stack telemetry is never silently dropped across the
 * multiple gate sites (fix-all-comparison-sites).
 */
export function layoutRepairActed(stats: SanitizationStats): boolean {
  const d = stats.blockLayout
  return d !== undefined && (d.repairedMessages > 0 || d.insertedMarkers > 0)
}

/**
 * Convert {@link SanitizationStats} to the history-facing `SanitizationInfo` shape
 * (drops `inlineSystemConverted`, which is a role-conversion count, not a block
 * removal). Shared by the legacy handler's `runInitialSanitizationAndRecord` and
 * the v4 Anthropic codec so both record the identical sanitization envelope. The
 * `destack` counters are surfaced only when de-stack acted (see {@link layoutRepairActed}),
 * keeping the envelope byte-identical for the common no-op case.
 */
export function toSanitizationInfo(stats: SanitizationStats): SanitizationInfo {
  const info: SanitizationInfo = {
    totalBlocksRemoved: stats.totalBlocksRemoved,
    orphanedToolUseCount: stats.orphanedToolUseCount,
    orphanedToolResultCount: stats.orphanedToolResultCount,
    fixedNameCount: stats.fixedNameCount,
    emptyTextBlocksRemoved: stats.emptyTextBlocksRemoved,
    emptyThinkingBlocksRemoved: stats.emptyThinkingBlocksRemoved,
    systemReminderRemovals: stats.systemReminderRemovals,
  }
  if (layoutRepairActed(stats)) info.blockLayout = stats.blockLayout
  return info
}
