import consola from "consola"

import type { SanitizeResult } from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  countAnthropicContentBlocks,
  filterEmptyAnthropicTextBlocks,
  filterEmptySystemTextBlocks,
} from "./content-blocks"

export interface SanitizationStats {
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
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
  const finalMessages = filterEmptyAnthropicTextBlocks(messages)
  const finalSystem = filterEmptySystemTextBlocks(system)
  const totalBlocksRemoved = Math.max(0, originalBlockCount - countAnthropicContentBlocks(finalMessages))
  const emptyTextBlocksRemoved = Math.max(
    0,
    totalBlocksRemoved - toolStats.orphanedToolUseCount - toolStats.orphanedToolResultCount,
  )

  if (toolStats.fixedNameCount > 0) {
    consola.debug(`[Sanitizer:Anthropic] Fixed ${toolStats.fixedNameCount} tool name casing mismatches`)
  }

  if (totalBlocksRemoved > 0 && (toolStats.orphanedToolUseCount > 0 || toolStats.orphanedToolResultCount > 0)) {
    const parts: Array<string> = []
    if (toolStats.orphanedToolUseCount > 0) parts.push(`${toolStats.orphanedToolUseCount} orphaned tool_use`)
    if (toolStats.orphanedToolResultCount > 0) parts.push(`${toolStats.orphanedToolResultCount} orphaned tool_result`)
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
      systemReminderRemovals,
      totalBlocksRemoved,
    },
  }
}
