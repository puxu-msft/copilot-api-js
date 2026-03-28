/**
 * Auto-truncate module: Automatically truncates conversation history
 * when it exceeds token limits (OpenAI format).
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Token limit enforcement with learned calibration
 * - Preserves system messages
 * - Filters orphaned tool_result and tool_use messages
 * - Optional smart compression of old tool_result content
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload, Message } from "~/types/api/openai-chat-completions"

import { getTokenCount } from "~/lib/models/tokenizer"
import { bytesToKB } from "~/lib/utils"

import type { AutoTruncateConfig } from "../auto-truncate"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  calibrate,
  computeSafetyMargin,
  getLearnedLimits,
} from "../auto-truncate"
import { state } from "~/lib/state"
import { extractOpenAISystemMessages } from "./orphan-filter"
import {
  addCompressionNotice,
  cleanupMessages,
  createTruncationMarker,
  createTruncationSystemContext,
  findOptimalPreserveIndex,
  generateRemovedMessagesSummary,
  smartCompressToolResults,
} from "./auto-truncate/truncation"
import { estimateMessageTokens } from "./auto-truncate/token-counting"

// ============================================================================
// Result Types
// ============================================================================

/** Result of auto-truncate operation */
export interface OpenAIAutoTruncateResult {
  payload: ChatCompletionsPayload
  wasTruncated: boolean
  originalTokens: number
  compactedTokens: number
  removedMessageCount: number
  /** Processing time in milliseconds */
  processingTimeMs: number
}

/** Result of needs-compaction check */
export interface OpenAICompactionCheckResult {
  needed: boolean
  currentTokens: number
  tokenLimit: number
  reason?: "tokens"
}

// ============================================================================
// Limit Calculation
// ============================================================================

/**
 * Calculate the effective token limit for auto-truncate.
 * Uses explicit target if provided, otherwise learned limits with calibration,
 * otherwise model capabilities with safety margin.
 *
 * Returns undefined when no limit information is available — the caller
 * should skip truncation rather than guess with a hardcoded default.
 */
function calculateTokenLimit(model: Model, config: AutoTruncateConfig): number | undefined {
  // Use explicit target if provided (reactive retry — caller already applied margin)
  if (config.targetTokenLimit !== undefined) {
    return config.targetTokenLimit
  }

  // Check for learned limits (adjusted based on previous errors)
  const learned = getLearnedLimits(model.id)
  if (learned) {
    const margin = computeSafetyMargin(learned.sampleCount)
    return Math.floor(learned.tokenLimit * (1 - margin))
  }

  // Use model capabilities with static safety margin
  const rawTokenLimit =
    model.capabilities?.limits?.max_context_window_tokens ?? model.capabilities?.limits?.max_prompt_tokens

  if (rawTokenLimit === undefined) return undefined

  return Math.floor(rawTokenLimit * (1 - config.safetyMarginPercent / 100))
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Check if payload needs compaction based on learned model limits.
 * Returns early with `needed: false` when no limits are known for the model.
 */
export async function checkNeedsCompactionOpenAI(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<OpenAICompactionCheckResult> {
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

  const tokenCount = await getTokenCount(payload, model)
  const rawTokens = tokenCount.input

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

// ============================================================================
// Truncation Steps
// ============================================================================

/** Shared context for truncation operations */
interface TruncationContext {
  payload: ChatCompletionsPayload
  model: Model
  cfg: AutoTruncateConfig
  tokenLimit: number
  originalTokens: number
  originalBytes: number
  startTime: number
}

function buildTimedResult(
  ctx: TruncationContext,
  result: Omit<OpenAIAutoTruncateResult, "processingTimeMs">,
): OpenAIAutoTruncateResult {
  return { ...result, processingTimeMs: Math.round(performance.now() - ctx.startTime) }
}

/**
 * Step 1: Try compressing tool results to fit within limits.
 * First compresses old tool results, then all if needed.
 * Returns early result if compression alone is sufficient.
 */
async function tryCompressToolResults(
  ctx: TruncationContext,
): Promise<{ workingMessages: Array<Message>; compressedCount: number; earlyResult?: OpenAIAutoTruncateResult }> {
  if (!state.compressToolResultsBeforeTruncate) {
    return { workingMessages: ctx.payload.messages, compressedCount: 0 }
  }

  // Step 1a: Compress old tool messages
  const compressionResult = smartCompressToolResults(
    ctx.payload.messages,
    ctx.tokenLimit,
    ctx.cfg.preserveRecentPercent,
  )
  let workingMessages = compressionResult.messages
  let compressedCount = compressionResult.compressedCount

  // Check if compression alone was enough
  const compressedPayload = { ...ctx.payload, messages: workingMessages }
  const compressedBytes = JSON.stringify(compressedPayload).length
  const compressedTokenCount = await getTokenCount(compressedPayload, ctx.model)

  if (compressedTokenCount.input <= ctx.tokenLimit) {
    const elapsedMs = Math.round(performance.now() - ctx.startTime)
    consola.info(
      `[AutoTruncate:OpenAI] tokens: ${ctx.originalTokens}→${compressedTokenCount.input}, `
        + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(compressedBytes)}KB `
        + `(compressed ${compressedCount} tool_results) [${elapsedMs}ms]`,
    )

    const noticePayload = addCompressionNotice(compressedPayload, compressedCount)
    // Estimate notice token overhead instead of full recount (~150 chars / 4 + framing)
    const noticeTokenOverhead = Math.ceil(150 / 4) + 10

    return {
      workingMessages,
      compressedCount,
      earlyResult: buildTimedResult(ctx, {
        payload: noticePayload,
        wasTruncated: true,
        originalTokens: ctx.originalTokens,
        compactedTokens: compressedTokenCount.input + noticeTokenOverhead,
        removedMessageCount: 0,
      }),
    }
  }

  // Step 1b: Compress ALL tool messages (including recent ones)
  const allCompression = smartCompressToolResults(
    workingMessages,
    ctx.tokenLimit,
    0.0, // preservePercent=0 means compress all messages
  )
  if (allCompression.compressedCount > 0) {
    workingMessages = allCompression.messages
    compressedCount += allCompression.compressedCount

    // Check if compressing all was enough
    const allCompressedPayload = { ...ctx.payload, messages: workingMessages }
    const allCompressedBytes = JSON.stringify(allCompressedPayload).length
    const allCompressedTokenCount = await getTokenCount(allCompressedPayload, ctx.model)

    if (allCompressedTokenCount.input <= ctx.tokenLimit) {
      const elapsedMs = Math.round(performance.now() - ctx.startTime)
      consola.info(
        `[AutoTruncate:OpenAI] tokens: ${ctx.originalTokens}→${allCompressedTokenCount.input}, `
          + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(allCompressedBytes)}KB `
          + `(compressed ${compressedCount} tool_results, including recent) [${elapsedMs}ms]`,
      )

      const noticePayload = addCompressionNotice(allCompressedPayload, compressedCount)
      // Estimate notice token overhead instead of full recount
      const noticeTokenOverhead = Math.ceil(150 / 4) + 10

      return {
        workingMessages,
        compressedCount,
        earlyResult: buildTimedResult(ctx, {
          payload: noticePayload,
          wasTruncated: true,
          originalTokens: ctx.originalTokens,
          compactedTokens: allCompressedTokenCount.input + noticeTokenOverhead,
          removedMessageCount: 0,
        }),
      }
    }
  }

  return { workingMessages, compressedCount }
}

/**
 * Step 2: Remove messages to fit within limits using binary search.
 * Handles orphan cleanup, summary generation, and result assembly.
 */
async function truncateByMessageRemoval(
  ctx: TruncationContext,
  workingMessages: Array<Message>,
  compressedCount: number,
): Promise<OpenAIAutoTruncateResult> {
  // Extract system messages from working messages
  const { systemMessages, conversationMessages } = extractOpenAISystemMessages(workingMessages)

  // Calculate system message token sizes
  const systemTokens = systemMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)

  // Find optimal preserve index
  const preserveIndex = findOptimalPreserveIndex({
    messages: conversationMessages,
    systemTokens,
    tokenLimit: ctx.tokenLimit,
  })

  // Check if we can compact
  if (preserveIndex >= conversationMessages.length) {
    consola.warn("[AutoTruncate:OpenAI] Would need to remove all messages")
    return buildTimedResult(ctx, {
      payload: ctx.payload,
      wasTruncated: false,
      originalTokens: ctx.originalTokens,
      compactedTokens: ctx.originalTokens,
      removedMessageCount: 0,
    })
  }

  // Build preserved messages and clean up orphans
  let preserved = conversationMessages.slice(preserveIndex)
  preserved = cleanupMessages(preserved)

  if (preserved.length === 0) {
    consola.warn("[AutoTruncate:OpenAI] All messages filtered out after cleanup")
    return buildTimedResult(ctx, {
      payload: ctx.payload,
      wasTruncated: false,
      originalTokens: ctx.originalTokens,
      compactedTokens: ctx.originalTokens,
      removedMessageCount: 0,
    })
  }

  // Calculate removed messages and generate summary
  const removedMessages = conversationMessages.slice(0, preserveIndex)
  const removedCount = conversationMessages.length - preserved.length
  const summary = generateRemovedMessagesSummary(removedMessages)

  // Build new payload with truncation context
  let newSystemMessages = systemMessages
  let newMessages = preserved

  // Prefer adding context to last system message (cleaner for the model)
  if (systemMessages.length > 0) {
    const truncationContext = createTruncationSystemContext(removedCount, compressedCount, summary)
    const lastSystemIdx = systemMessages.length - 1
    const lastSystem = systemMessages[lastSystemIdx]

    // Append context to last system message
    const updatedSystem: Message = {
      ...lastSystem,

      content: typeof lastSystem.content === "string" ? lastSystem.content + truncationContext : lastSystem.content, // Can't append to array content
    }
    newSystemMessages = [...systemMessages.slice(0, lastSystemIdx), updatedSystem]
  } else {
    // No system messages, use marker message
    const marker = createTruncationMarker(removedCount, compressedCount, summary)
    newMessages = [marker, ...preserved]
  }

  const newPayload: ChatCompletionsPayload = {
    ...ctx.payload,
    messages: [...newSystemMessages, ...newMessages],
  }

  // Verify the result
  const newBytes = JSON.stringify(newPayload).length
  const newTokenCount = await getTokenCount(newPayload, ctx.model)

  // Log single line summary
  const actions: Array<string> = []
  if (removedCount > 0) actions.push(`removed ${removedCount} msgs`)
  if (compressedCount > 0) actions.push(`compressed ${compressedCount} tool_results`)
  const actionInfo = actions.length > 0 ? ` (${actions.join(", ")})` : ""

  const elapsedMs = Math.round(performance.now() - ctx.startTime)
  consola.info(
    `[AutoTruncate:OpenAI] tokens: ${ctx.originalTokens}→${newTokenCount.input}, `
      + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(newBytes)}KB${actionInfo} [${elapsedMs}ms]`,
  )

  // Warn if still over token limit
  if (newTokenCount.input > ctx.tokenLimit) {
    consola.warn(`[AutoTruncate:OpenAI] Result still over token limit (${newTokenCount.input} > ${ctx.tokenLimit})`)
  }

  return buildTimedResult(ctx, {
    payload: newPayload,
    wasTruncated: true,
    originalTokens: ctx.originalTokens,
    compactedTokens: newTokenCount.input,
    removedMessageCount: removedCount,
  })
}

// ============================================================================
// Public Entry Points
// ============================================================================

/**
 * Perform auto-truncation on a payload that exceeds limits.
 * Uses binary search to find the optimal truncation point.
 *
 * Pipeline:
 * 1. Check if compaction is needed
 * 2. Try compressing tool results (old first, then all)
 * 3. If still over limit, remove messages via binary search
 */
export async function autoTruncateOpenAI(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<OpenAIAutoTruncateResult> {
  const startTime = performance.now()
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const tokenLimit = calculateTokenLimit(model, cfg)

  // No limit information available — skip truncation and let the server decide
  if (tokenLimit === undefined) {
    return {
      payload,
      wasTruncated: false,
      originalTokens: 0,
      compactedTokens: 0,
      removedMessageCount: 0,
      processingTimeMs: Math.round(performance.now() - startTime),
    }
  }

  // Measure original size
  const originalBytes = JSON.stringify(payload).length
  const originalTokens = (await getTokenCount(payload, model)).input

  const ctx: TruncationContext = {
    payload,
    model,
    cfg,
    tokenLimit,
    originalTokens,
    originalBytes,
    startTime,
  }

  // Check if compaction is needed
  if (originalTokens <= tokenLimit) {
    return buildTimedResult(ctx, {
      payload,
      wasTruncated: false,
      originalTokens,
      compactedTokens: originalTokens,
      removedMessageCount: 0,
    })
  }

  // Step 1: Try tool result compression
  const { workingMessages, compressedCount, earlyResult } = await tryCompressToolResults(ctx)
  if (earlyResult) return earlyResult

  // Step 2: Message removal via binary search
  return await truncateByMessageRemoval(ctx, workingMessages, compressedCount)
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 */
export function createTruncationResponseMarkerOpenAI(result: OpenAIAutoTruncateResult): string {
  if (!result.wasTruncated) return ""

  const reduction = result.originalTokens - result.compactedTokens
  const percentage = Math.round((reduction / result.originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${result.removedMessageCount} messages removed, `
    + `${result.originalTokens} → ${result.compactedTokens} tokens (${percentage}% reduction)]`
  )
}
