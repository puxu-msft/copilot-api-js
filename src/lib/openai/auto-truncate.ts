/**
 * Auto-truncate module: Automatically truncates conversation history
 * when it exceeds token or byte limits (OpenAI format).
 *
 * Key features:
 * - Binary search for optimal truncation point
 * - Considers both token and byte limits
 * - Preserves system messages
 * - Filters orphaned tool_result and tool_use messages
 * - Dynamic byte limit adjustment on 413 errors
 * - Optional smart compression of old tool_result content
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload, Message } from "~/lib/openai/client"

import { getTokenCount } from "~/lib/models/tokenizer"
import {
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
} from "~/lib/openai/orphan-filter"
import { state } from "~/lib/state"
import { bytesToKB } from "~/lib/utils"

import type { AutoTruncateConfig } from "../auto-truncate-common"

import {
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  LARGE_TOOL_RESULT_THRESHOLD,
  compressToolResultContent,
  getEffectiveByteLimitBytes,
  getEffectiveTokenLimit,
} from "../auto-truncate-common"

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
  currentBytes: number
  byteLimit: number
  reason?: "tokens" | "bytes" | "both"
}

// ============================================================================
// Limit Calculation
// ============================================================================

interface Limits {
  tokenLimit: number
  byteLimit: number
}

function calculateLimits(model: Model, config: AutoTruncateConfig): Limits {
  // Use explicit target if provided (reactive retry — caller already applied margin)
  if (config.targetTokenLimit !== undefined || config.targetByteLimitBytes !== undefined) {
    return {
      tokenLimit: config.targetTokenLimit ?? model.capabilities?.limits?.max_context_window_tokens ?? 128000,
      byteLimit: config.targetByteLimitBytes ?? getEffectiveByteLimitBytes(),
    }
  }

  // Check for dynamic token limit (adjusted based on previous errors)
  const dynamicLimit = getEffectiveTokenLimit(model.id)

  // Use dynamic limit if available, otherwise use model capabilities
  const rawTokenLimit =
    dynamicLimit
    ?? model.capabilities?.limits?.max_context_window_tokens
    ?? model.capabilities?.limits?.max_prompt_tokens
    ?? 128000

  const tokenLimit = Math.floor(rawTokenLimit * (1 - config.safetyMarginPercent / 100))
  const byteLimit = getEffectiveByteLimitBytes()
  return { tokenLimit, byteLimit }
}

// ============================================================================
// Message Utilities
// ============================================================================

/** Estimate tokens for a single message (fast approximation) */
function estimateMessageTokens(msg: Message): number {
  let charCount = 0

  if (typeof msg.content === "string") {
    charCount = msg.content.length
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") {
        charCount += part.text.length
      } else if ("image_url" in part) {
        // Base64 images are large but compressed in token counting
        charCount += Math.min(part.image_url.url.length, 10000)
      }
    }
  }

  if (msg.tool_calls) {
    charCount += JSON.stringify(msg.tool_calls).length
  }

  // ~4 chars per token + message overhead
  return Math.ceil(charCount / 4) + 10
}

/** Get byte size of a message (memoized to avoid redundant JSON.stringify) */
const messageBytesCache = new WeakMap<object, number>()
function getMessageBytes(msg: Message): number {
  let cached = messageBytesCache.get(msg)
  if (cached !== undefined) return cached
  cached = JSON.stringify(msg).length
  messageBytesCache.set(msg, cached)
  return cached
}

/** Calculate cumulative token and byte sums from the end of the message array */
function calculateCumulativeSums(messages: Array<Message>): { cumTokens: Array<number>; cumBytes: Array<number> } {
  const n = messages.length
  const cumTokens = Array.from<number>({ length: n + 1 }).fill(0)
  const cumBytes = Array.from<number>({ length: n + 1 }).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    cumTokens[i] = cumTokens[i + 1] + estimateMessageTokens(messages[i])
    cumBytes[i] = cumBytes[i + 1] + getMessageBytes(messages[i]) + 1
  }
  return { cumTokens, cumBytes }
}

/**
 * Clean up orphaned tool messages and ensure valid conversation start.
 * Loops until stable since each pass may create new orphans.
 */
function cleanupMessages(messages: Array<Message>): Array<Message> {
  let result = messages
  let prevLength: number
  do {
    prevLength = result.length
    result = filterOpenAIOrphanedToolResults(result)
    result = filterOpenAIOrphanedToolUse(result)
    result = ensureOpenAIStartsWithUser(result)
  } while (result.length !== prevLength)
  return result
}

// ============================================================================
// Smart Tool Result Compression
// ============================================================================

/**
 * Smart compression strategy for OpenAI format:
 * 1. Calculate tokens/bytes from the end until reaching preservePercent of limit
 * 2. Messages before that threshold get their tool content compressed
 * 3. Returns compressed messages and stats
 *
 * @param preservePercent - Percentage of context to preserve uncompressed (0.0-1.0)
 */
function smartCompressToolResults(
  messages: Array<Message>,
  tokenLimit: number,
  byteLimit: number,
  preservePercent: number,
): {
  messages: Array<Message>
  compressedCount: number
  compressThresholdIndex: number
} {
  // Calculate cumulative size from the end
  const n = messages.length
  const { cumTokens, cumBytes } = calculateCumulativeSums(messages)

  // Find the threshold index where we've used the preserve percentage of the limit
  const preserveTokenLimit = Math.floor(tokenLimit * preservePercent)
  const preserveByteLimit = Math.floor(byteLimit * preservePercent)

  let thresholdIndex = n
  for (let i = n - 1; i >= 0; i--) {
    if (cumTokens[i] > preserveTokenLimit || cumBytes[i] > preserveByteLimit) {
      thresholdIndex = i + 1
      break
    }
    thresholdIndex = i
  }

  // If threshold is at the end, nothing to compress
  if (thresholdIndex >= n) {
    return { messages, compressedCount: 0, compressThresholdIndex: n }
  }

  // Compress tool messages before threshold
  const result: Array<Message> = []
  let compressedCount = 0

  for (const [i, msg] of messages.entries()) {
    if (
      i < thresholdIndex
      && msg.role === "tool"
      && typeof msg.content === "string"
      && msg.content.length > LARGE_TOOL_RESULT_THRESHOLD
    ) {
      compressedCount++
      result.push({
        ...msg,
        content: compressToolResultContent(msg.content),
      })
      continue
    }
    result.push(msg)
  }

  return {
    messages: result,
    compressedCount,
    compressThresholdIndex: thresholdIndex,
  }
}

// ============================================================================
// Binary Search Algorithm
// ============================================================================

interface PreserveSearchParams {
  messages: Array<Message>
  systemBytes: number
  systemTokens: number
  payloadOverhead: number
  tokenLimit: number
  byteLimit: number
  checkTokenLimit: boolean
  checkByteLimit: boolean
}

/**
 * Find the optimal index from which to preserve messages.
 * Uses binary search with pre-calculated cumulative sums.
 * Returns the smallest index where the preserved portion fits within limits.
 */
function findOptimalPreserveIndex(params: PreserveSearchParams): number {
  const {
    messages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit,
    byteLimit,
    checkTokenLimit,
    checkByteLimit,
  } = params

  if (messages.length === 0) return 0

  // Account for truncation marker (~200 bytes, ~50 tokens)
  const markerBytes = 200
  const markerTokens = 50

  // Calculate available budget after system messages, marker, and overhead
  const availableTokens = tokenLimit - systemTokens - markerTokens
  // For bytes: payload = overhead + "[" + messages.join(",") + "]"
  // Each message adds: JSON.stringify(msg) + 1 (comma, except last)
  const availableBytes = byteLimit - payloadOverhead - systemBytes - markerBytes

  if ((checkTokenLimit && availableTokens <= 0) || (checkByteLimit && availableBytes <= 0)) {
    return messages.length // Cannot fit any messages
  }

  // Pre-calculate cumulative sums from the end
  const n = messages.length
  const { cumTokens, cumBytes } = calculateCumulativeSums(messages)

  // Binary search for the smallest index where enabled limits are satisfied
  let left = 0
  let right = n

  while (left < right) {
    const mid = (left + right) >>> 1
    const tokensFit = !checkTokenLimit || cumTokens[mid] <= availableTokens
    const bytesFit = !checkByteLimit || cumBytes[mid] <= availableBytes
    if (tokensFit && bytesFit) {
      right = mid // Can keep more messages
    } else {
      left = mid + 1 // Need to remove more
    }
  }

  return left
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Check if payload needs compaction based on model limits or byte size.
 */
export async function checkNeedsCompactionOpenAI(
  payload: ChatCompletionsPayload,
  model: Model,
  config: Partial<AutoTruncateConfig> = {},
): Promise<OpenAICompactionCheckResult> {
  const cfg = { ...DEFAULT_AUTO_TRUNCATE_CONFIG, ...config }
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  const tokenCount = await getTokenCount(payload, model)
  const currentTokens = tokenCount.input
  const currentBytes = JSON.stringify(payload).length

  const exceedsTokens = cfg.checkTokenLimit && currentTokens > tokenLimit
  const exceedsBytes = cfg.checkByteLimit && currentBytes > byteLimit

  let reason: "tokens" | "bytes" | "both" | undefined
  if (exceedsTokens && exceedsBytes) {
    reason = "both"
  } else if (exceedsTokens) {
    reason = "tokens"
  } else if (exceedsBytes) {
    reason = "bytes"
  }

  return {
    needed: exceedsTokens || exceedsBytes,
    currentTokens,
    tokenLimit,
    currentBytes,
    byteLimit,
    reason,
  }
}

/**
 * Generate a summary of removed messages for context.
 * Extracts key information like tool calls and topics.
 */
function generateRemovedMessagesSummary(removedMessages: Array<Message>): string {
  const toolCalls: Array<string> = []
  let userMessageCount = 0
  let assistantMessageCount = 0

  for (const msg of removedMessages) {
    if (msg.role === "user") {
      userMessageCount++
    } else if (msg.role === "assistant") {
      assistantMessageCount++
    }

    // Extract tool call names
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name) {
          toolCalls.push(tc.function.name)
        }
      }
    }
  }

  // Build summary parts
  const parts: Array<string> = []

  // Message breakdown
  if (userMessageCount > 0 || assistantMessageCount > 0) {
    const breakdown = []
    if (userMessageCount > 0) breakdown.push(`${userMessageCount} user`)
    if (assistantMessageCount > 0) breakdown.push(`${assistantMessageCount} assistant`)
    parts.push(`Messages: ${breakdown.join(", ")}`)
  }

  // Tool calls
  if (toolCalls.length > 0) {
    // Deduplicate and limit
    const uniqueTools = [...new Set(toolCalls)]
    const displayTools =
      uniqueTools.length > 5 ? [...uniqueTools.slice(0, 5), `+${uniqueTools.length - 5} more`] : uniqueTools
    parts.push(`Tools used: ${displayTools.join(", ")}`)
  }

  return parts.join(". ")
}

/**
 * Add a compression notice to the system message.
 * Informs the model that some tool content has been compressed.
 */
function addCompressionNotice(payload: ChatCompletionsPayload, compressedCount: number): ChatCompletionsPayload {
  const notice =
    `\n\n[CONTEXT NOTE]\n`
    + `${compressedCount} large tool results have been compressed to reduce context size.\n`
    + `The compressed results show the beginning and end of the content with an omission marker.\n`
    + `If you need the full content, you can re-read the file or re-run the tool.\n`
    + `[END NOTE]`

  // Find last system message and append notice
  const messages = [...payload.messages]
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "system" || msg.role === "developer") {
      if (typeof msg.content === "string") {
        messages[i] = { ...msg, content: msg.content + notice }
      }
      break
    }
  }

  return { ...payload, messages }
}

/**
 * Create truncation context to append to system messages.
 */
function createTruncationSystemContext(removedCount: number, compressedCount: number, summary: string): string {
  let context = `\n\n[CONVERSATION CONTEXT]\n`

  if (removedCount > 0) {
    context += `${removedCount} earlier messages have been removed due to context window limits.\n`
  }

  if (compressedCount > 0) {
    context += `${compressedCount} large tool results have been compressed.\n`
  }

  if (summary) {
    context += `Summary of removed content: ${summary}\n`
  }

  context +=
    `If you need earlier context, ask the user or check available tools for conversation history access.\n`
    + `[END CONTEXT]`

  return context
}

/** Create a truncation marker message (fallback when no system message) */
function createTruncationMarker(removedCount: number, compressedCount: number, summary: string): Message {
  const parts: Array<string> = []

  if (removedCount > 0) {
    parts.push(`${removedCount} earlier messages removed`)
  }
  if (compressedCount > 0) {
    parts.push(`${compressedCount} tool results compressed`)
  }

  let content = `[CONTEXT MODIFIED: ${parts.join(", ")} to fit context limits]`
  if (summary) {
    content += `\n[Summary: ${summary}]`
  }
  return {
    role: "user",
    content,
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
  byteLimit: number
  originalTokens: number
  originalBytes: number
  exceedsTokens: boolean
  exceedsBytes: boolean
  startTime: number
}

function buildTimedResult(
  ctx: TruncationContext,
  result: Omit<OpenAIAutoTruncateResult, "processingTimeMs">,
): OpenAIAutoTruncateResult {
  return { ...result, processingTimeMs: Math.round(performance.now() - ctx.startTime) }
}

function getReasonLabel(exceedsTokens: boolean, exceedsBytes: boolean): string {
  if (exceedsTokens && exceedsBytes) return "tokens+size"
  if (exceedsBytes) return "size"
  return "tokens"
}

/**
 * Step 1: Try compressing tool results to fit within limits.
 * First compresses old tool results, then all if needed.
 * Returns early result if compression alone is sufficient.
 */
async function tryCompressToolResults(
  ctx: TruncationContext,
): Promise<{ workingMessages: Array<Message>; compressedCount: number; earlyResult?: OpenAIAutoTruncateResult }> {
  if (!state.compressToolResults) {
    return { workingMessages: ctx.payload.messages, compressedCount: 0 }
  }

  // Step 1a: Compress old tool messages
  const compressionResult = smartCompressToolResults(
    ctx.payload.messages,
    ctx.tokenLimit,
    ctx.byteLimit,
    ctx.cfg.preserveRecentPercent,
  )
  let workingMessages = compressionResult.messages
  let compressedCount = compressionResult.compressedCount

  // Check if compression alone was enough
  const compressedPayload = { ...ctx.payload, messages: workingMessages }
  const compressedBytes = JSON.stringify(compressedPayload).length
  const compressedTokenCount = await getTokenCount(compressedPayload, ctx.model)

  if (compressedTokenCount.input <= ctx.tokenLimit && compressedBytes <= ctx.byteLimit) {
    const reason = getReasonLabel(ctx.exceedsTokens, ctx.exceedsBytes)
    const elapsedMs = Math.round(performance.now() - ctx.startTime)
    consola.info(
      `[AutoTruncate:OpenAI] ${reason}: ${ctx.originalTokens}→${compressedTokenCount.input} tokens, `
        + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(compressedBytes)}KB `
        + `(compressed ${compressedCount} tool_results) [${elapsedMs}ms]`,
    )

    const noticePayload = addCompressionNotice(compressedPayload, compressedCount)
    const noticeTokenCount = await getTokenCount(noticePayload, ctx.model)

    return {
      workingMessages,
      compressedCount,
      earlyResult: buildTimedResult(ctx, {
        payload: noticePayload,
        wasTruncated: true,
        originalTokens: ctx.originalTokens,
        compactedTokens: noticeTokenCount.input,
        removedMessageCount: 0,
      }),
    }
  }

  // Step 1b: Compress ALL tool messages (including recent ones)
  const allCompression = smartCompressToolResults(
    workingMessages,
    ctx.tokenLimit,
    ctx.byteLimit,
    0.0, // preservePercent=0 means compress all messages
  )
  if (allCompression.compressedCount > 0) {
    workingMessages = allCompression.messages
    compressedCount += allCompression.compressedCount

    // Check if compressing all was enough
    const allCompressedPayload = { ...ctx.payload, messages: workingMessages }
    const allCompressedBytes = JSON.stringify(allCompressedPayload).length
    const allCompressedTokenCount = await getTokenCount(allCompressedPayload, ctx.model)

    if (allCompressedTokenCount.input <= ctx.tokenLimit && allCompressedBytes <= ctx.byteLimit) {
      const reason = getReasonLabel(ctx.exceedsTokens, ctx.exceedsBytes)
      const elapsedMs = Math.round(performance.now() - ctx.startTime)
      consola.info(
        `[AutoTruncate:OpenAI] ${reason}: ${ctx.originalTokens}→${allCompressedTokenCount.input} tokens, `
          + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(allCompressedBytes)}KB `
          + `(compressed ${compressedCount} tool_results, including recent) [${elapsedMs}ms]`,
      )

      const noticePayload = addCompressionNotice(allCompressedPayload, compressedCount)
      const noticeTokenCount = await getTokenCount(noticePayload, ctx.model)

      return {
        workingMessages,
        compressedCount,
        earlyResult: buildTimedResult(ctx, {
          payload: noticePayload,
          wasTruncated: true,
          originalTokens: ctx.originalTokens,
          compactedTokens: noticeTokenCount.input,
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

  // Calculate overhead: everything except the messages array content
  const messagesJson = JSON.stringify(workingMessages)
  const workingPayloadSize = JSON.stringify({
    ...ctx.payload,
    messages: workingMessages,
  }).length
  const payloadOverhead = workingPayloadSize - messagesJson.length

  // Calculate system message sizes
  /* eslint-disable @typescript-eslint/restrict-plus-operands -- numeric reduce, ESLint misreads Message operand */
  const systemBytes = systemMessages.reduce((sum, m) => sum + getMessageBytes(m) + 1, 0)
  const systemTokens = systemMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  /* eslint-enable @typescript-eslint/restrict-plus-operands */

  consola.debug(
    `[AutoTruncate:OpenAI] overhead=${bytesToKB(payloadOverhead)}KB, `
      + `system=${systemMessages.length} msgs (${bytesToKB(systemBytes)}KB)`,
  )

  // Find optimal preserve index
  const preserveIndex = findOptimalPreserveIndex({
    messages: conversationMessages,
    systemBytes,
    systemTokens,
    payloadOverhead,
    tokenLimit: ctx.tokenLimit,
    byteLimit: ctx.byteLimit,
    checkTokenLimit: ctx.cfg.checkTokenLimit,
    checkByteLimit: ctx.cfg.checkByteLimit,
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
      // eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- string concat, ESLint misreads Message type
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
  const reason = getReasonLabel(ctx.exceedsTokens, ctx.exceedsBytes)
  const actions: Array<string> = []
  if (removedCount > 0) actions.push(`removed ${removedCount} msgs`)
  if (compressedCount > 0) actions.push(`compressed ${compressedCount} tool_results`)
  const actionInfo = actions.length > 0 ? ` (${actions.join(", ")})` : ""

  const elapsedMs = Math.round(performance.now() - ctx.startTime)
  consola.info(
    `[AutoTruncate:OpenAI] ${reason}: ${ctx.originalTokens}→${newTokenCount.input} tokens, `
      + `${bytesToKB(ctx.originalBytes)}→${bytesToKB(newBytes)}KB${actionInfo} [${elapsedMs}ms]`,
  )

  // Warn if still over limit (shouldn't happen with correct algorithm)
  if (newBytes > ctx.byteLimit) {
    consola.warn(
      `[AutoTruncate:OpenAI] Result still over byte limit (${bytesToKB(newBytes)}KB > ${bytesToKB(ctx.byteLimit)}KB)`,
    )
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
  const { tokenLimit, byteLimit } = calculateLimits(model, cfg)

  // Measure original size
  const originalBytes = JSON.stringify(payload).length
  const originalTokens = (await getTokenCount(payload, model)).input

  const ctx: TruncationContext = {
    payload,
    model,
    cfg,
    tokenLimit,
    byteLimit,
    originalTokens,
    originalBytes,
    exceedsTokens: originalTokens > tokenLimit,
    exceedsBytes: originalBytes > byteLimit,
    startTime,
  }

  // Check if compaction is needed
  if (!ctx.exceedsTokens && !ctx.exceedsBytes) {
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
