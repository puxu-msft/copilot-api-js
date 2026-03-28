/**
 * Auto-truncate module for Anthropic-style messages.
 *
 * This module handles automatic truncation of Anthropic message format
 * when it exceeds token limits.
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Token limit enforcement with learned calibration
 * - Preserves system messages
 * - Filters orphaned tool_result and tool_use messages
 * - Smart compression of old tool_result content (e.g., Read tool results)
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import { state } from "~/lib/state"
import { bytesToKB } from "~/lib/utils"

import type { AutoTruncateConfig } from "../auto-truncate"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  calibrate,
  getLearnedLimits,
} from "../auto-truncate"
import {
  ensureAnthropicStartsWithUser,
  filterAnthropicOrphanedToolResults,
  filterAnthropicOrphanedToolUse,
  getAnthropicToolResultIds,
  getAnthropicToolUseIds,
} from "./auto-truncate/tool-utils"
import {
  contentToText,
  countFixedTokens,
  countMessageTokens,
  countMessagesTokens,
  countSystemTokens,
  countTotalInputTokens,
  countTotalTokens,
} from "./auto-truncate/token-counting"
import {
  addCompressionNotice,
  calculateTokenLimit,
  cleanupMessages,
  createTruncationMarker,
  createTruncationSystemContext,
  findOptimalPreserveIndex,
  generateRemovedMessagesSummary,
  smartCompressToolResults,
  stripThinkingBlocks,
} from "./auto-truncate/truncation"
export {
  ensureAnthropicStartsWithUser,
  filterAnthropicOrphanedToolResults,
  filterAnthropicOrphanedToolUse,
  getAnthropicToolResultIds,
  getAnthropicToolUseIds,
}
export {
  contentToText,
  countFixedTokens,
  countMessageTokens,
  countMessagesTokens,
  countSystemTokens,
  countTotalInputTokens,
  countTotalTokens,
}

// ============================================================================
// Result Types
// ============================================================================

export interface AnthropicAutoTruncateResult {
  payload: MessagesPayload
  wasTruncated: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
  /** Processing time in milliseconds */
  processingTimeMs: number
}

/**
 * Perform auto-truncation on an Anthropic payload that exceeds limits.
 */
export async function autoTruncateAnthropic(
  payload: MessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<AnthropicAutoTruncateResult> {
  const startTime = performance.now()

  // Helper to build result with timing
  const buildResult = (result: Omit<AnthropicAutoTruncateResult, "processingTimeMs">): AnthropicAutoTruncateResult => ({
    ...result,
    processingTimeMs: Math.round(performance.now() - startTime),
  })

  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const tokenLimit = calculateTokenLimit(model, cfg)

  // No limit information available — skip truncation and let the server decide
  if (tokenLimit === undefined) {
    return buildResult({
      payload,
      wasTruncated: false,
      originalTokens: 0,
      compactedTokens: 0,
      removedMessageCount: 0,
    })
  }

  // Compute fixed overhead tokens (system + tools) once — these don't change during truncation
  const fixedTokens = await countFixedTokens(payload, model)

  // Measure original size
  const originalMsgTokens = await countMessagesTokens(payload.messages, model)
  const originalTokens = fixedTokens + originalMsgTokens

  // Check if compaction is needed
  if (originalTokens <= tokenLimit) {
    return buildResult({
      payload,
      wasTruncated: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Step 1: Strip thinking blocks from old assistant messages
  // These don't count as input tokens per Anthropic docs, but they consume request body space.
  // Preserve thinking in the last 4 messages (2 exchanges) for context continuity.
  const { messages: thinkingStripped, strippedCount: thinkingStrippedCount } = stripThinkingBlocks(payload.messages, 4)
  let workingMessages = thinkingStripped

  // Check if stripping alone was enough
  if (thinkingStrippedCount > 0) {
    const strippedMsgTokens = await countMessagesTokens(workingMessages, model)
    const strippedTokens = fixedTokens + strippedMsgTokens

    if (strippedTokens <= tokenLimit) {
      const elapsedMs = Math.round(performance.now() - startTime)
      consola.info(
        `[AutoTruncate:Anthropic] tokens: ${originalTokens}→${strippedTokens} `
          + `(stripped ${thinkingStrippedCount} thinking blocks) [${elapsedMs}ms]`,
      )

      return buildResult({
        payload: { ...payload, messages: workingMessages },
        wasTruncated: true,
        originalTokens,
        compactedTokens: strippedTokens,
        removedMessageCount: 0,
      })
    }
  }

  // Step 2: Smart compress old tool_results (if enabled)
  // Compress tool_results in messages that are beyond the preserve threshold
  let compressedCount = 0

  if (state.compressToolResultsBeforeTruncate) {
    const compressionResult = smartCompressToolResults(workingMessages, tokenLimit, cfg.preserveRecentPercent)
    workingMessages = compressionResult.messages
    compressedCount = compressionResult.compressedCount

    // Check if compression alone was enough
    const compressedMsgTokens = await countMessagesTokens(workingMessages, model)
    const compressedTokens = fixedTokens + compressedMsgTokens

    if (compressedTokens <= tokenLimit) {
      const elapsedMs = Math.round(performance.now() - startTime)
      consola.info(
        `[AutoTruncate:Anthropic] tokens: ${originalTokens}→${compressedTokens} `
          + `(compressed ${compressedCount} tool_results) [${elapsedMs}ms]`,
      )

      // Add compression notice to system prompt
      const compressedPayload = { ...payload, messages: workingMessages }
      const noticePayload = addCompressionNotice(compressedPayload, compressedCount)

      // Estimate notice token overhead instead of full recount
      const noticeTokenOverhead = Math.ceil(150 / 4) + 4 // ~150 chars in notice text
      return buildResult({
        payload: noticePayload,
        wasTruncated: true,
        originalTokens,
        compactedTokens: compressedTokens + noticeTokenOverhead,
        removedMessageCount: 0,
      })
    }

    // Step 2.5: Compress ALL tool_results (including recent ones)
    // If compressing only old tool_results wasn't enough, try compressing all of them
    // before resorting to message removal
    const allCompression = smartCompressToolResults(
      workingMessages,
      tokenLimit,
      0.0, // preservePercent=0 means compress all messages
    )
    if (allCompression.compressedCount > 0) {
      workingMessages = allCompression.messages
      compressedCount += allCompression.compressedCount

      // Check if compressing all was enough
      const allCompressedMsgTokens = await countMessagesTokens(workingMessages, model)
      const allCompressedTokens = fixedTokens + allCompressedMsgTokens

      if (allCompressedTokens <= tokenLimit) {
        const elapsedMs = Math.round(performance.now() - startTime)
        consola.info(
          `[AutoTruncate:Anthropic] tokens: ${originalTokens}→${allCompressedTokens} `
            + `(compressed ${compressedCount} tool_results, including recent) [${elapsedMs}ms]`,
        )

        const allCompressedPayload = { ...payload, messages: workingMessages }
        const noticePayload = addCompressionNotice(allCompressedPayload, compressedCount)

        // Estimate notice token overhead instead of full recount
        const noticeTokenOverhead = Math.ceil(150 / 4) + 4
        return buildResult({
          payload: noticePayload,
          wasTruncated: true,
          originalTokens,
          compactedTokens: allCompressedTokens + noticeTokenOverhead,
          removedMessageCount: 0,
        })
      }
    }
  }

  // Step 3: Compression wasn't enough (or disabled), proceed with message removal
  // Use working messages (compressed if enabled, original otherwise)

  // Calculate system tokens for the binary search
  const systemTokens = await countSystemTokens(payload.system, model)

  // Find optimal preserve index on working messages
  const preserveIndex = findOptimalPreserveIndex({
    messages: workingMessages,
    systemTokens,
    tokenLimit,
  })

  // Check if we can compact
  if (preserveIndex >= workingMessages.length) {
    consola.warn("[AutoTruncate:Anthropic] Would need to remove all messages")
    return buildResult({
      payload,
      wasTruncated: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Build preserved messages from working (compressed) messages
  let preserved = workingMessages.slice(preserveIndex)

  // Clean up the message list - filter orphaned tool blocks in two passes
  // (one pass to collect IDs, one to filter), then ensure starts with user
  preserved = cleanupMessages(preserved)

  if (preserved.length === 0) {
    consola.warn("[AutoTruncate:Anthropic] All messages filtered out after cleanup")
    return buildResult({
      payload,
      wasTruncated: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Calculate removed messages and generate summary
  // Use original messages for summary (uncompressed content is more informative)
  const removedMessages = payload.messages.slice(0, preserveIndex)
  const removedCount = workingMessages.length - preserved.length
  const summary = generateRemovedMessagesSummary(removedMessages)

  // Build new payload with truncation context
  let newSystem = payload.system
  let newMessages = preserved

  // Prefer adding context to system prompt (cleaner for the model)
  if (payload.system !== undefined) {
    const truncationContext = createTruncationSystemContext(removedCount, compressedCount, summary)
    if (typeof payload.system === "string") {
      newSystem = truncationContext + payload.system
    } else if (Array.isArray(payload.system)) {
      // Prepend as first text block
      newSystem = [{ type: "text" as const, text: truncationContext }, ...payload.system]
    }
  } else {
    // No system prompt, use marker message
    const marker = createTruncationMarker(removedCount, compressedCount, summary)
    newMessages = [marker, ...preserved]
  }

  const newPayload: MessagesPayload = {
    ...payload,
    system: newSystem,
    messages: newMessages,
  }

  // Verify the result — only count messages (reuse cached fixed tokens)
  const newBytes = JSON.stringify(newPayload).length
  const newMsgTokens = await countMessagesTokens(newMessages, model)
  // Re-count system tokens if system was modified (truncation context added)
  const newSystemTokens = newSystem !== payload.system ? await countSystemTokens(newSystem, model) : systemTokens
  const toolsTokens = fixedTokens - (await countSystemTokens(payload.system, model))
  const newTokens = newSystemTokens + toolsTokens + newMsgTokens

  // Log single line summary
  const actions: Array<string> = []
  if (removedCount > 0) actions.push(`removed ${removedCount} msgs`)
  if (thinkingStrippedCount > 0) actions.push(`stripped ${thinkingStrippedCount} thinking blocks`)
  if (compressedCount > 0) actions.push(`compressed ${compressedCount} tool_results`)
  const actionInfo = actions.length > 0 ? ` (${actions.join(", ")})` : ""

  const elapsedMs = Math.round(performance.now() - startTime)
  consola.info(
    `[AutoTruncate:Anthropic] tokens: ${originalTokens}→${newTokens}, `
      + `${bytesToKB(newBytes)}KB${actionInfo} [${elapsedMs}ms]`,
  )

  // Warn if still over token limit
  if (newTokens > tokenLimit) {
    consola.warn(`[AutoTruncate:Anthropic] Result still over token limit (${newTokens} > ${tokenLimit})`)
  }

  return buildResult({
    payload: newPayload,
    wasTruncated: true,
    originalTokens,
    compactedTokens: newTokens,
    removedMessageCount: removedCount,
  })
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 */
export function createTruncationResponseMarkerAnthropic(result: AnthropicAutoTruncateResult): string {
  if (!result.wasTruncated) return ""

  const reduction = result.originalTokens - result.compactedTokens
  const percentage = Math.round((reduction / result.originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${result.removedMessageCount} messages removed, `
    + `${result.originalTokens} → ${result.compactedTokens} tokens (${percentage}% reduction)]`
  )
}

/**
 * Check if payload needs compaction based on learned model limits.
 * Returns early with `needed: false` when no limits are known for the model.
 */
export async function checkNeedsCompactionAnthropic(
  payload: MessagesPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<{
  needed: boolean
  currentTokens: number
  tokenLimit: number
  reason?: "tokens"
}> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }

  // If no learned limits and no explicit target, skip pre-check
  // (we don't know the real limit yet — let the server tell us)
  const learned = getLearnedLimits(model.id)
  if (!learned && cfg.targetTokenLimit === undefined) {
    return {
      needed: false,
      currentTokens: 0,
      tokenLimit: 0,
    }
  }

  const tokenLimit = calculateTokenLimit(model, cfg)

  // Defensive: should not reach here without a resolvable limit (guarded by early return above),
  // but satisfy the type system
  if (tokenLimit === undefined) {
    return {
      needed: false,
      currentTokens: 0,
      tokenLimit: 0,
    }
  }

  const rawTokens = await countTotalTokens(payload, model)

  // Apply calibration to adjust the GPT tokenizer estimate
  const currentTokens = learned && learned.sampleCount > 0 ? calibrate(model.id, rawTokens) : rawTokens

  const exceedsTokens = cfg.checkTokenLimit && currentTokens > tokenLimit

  return {
    needed: exceedsTokens,
    currentTokens,
    tokenLimit,
    reason: exceedsTokens ? "tokens" : undefined,
  }
}
