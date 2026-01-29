/**
 * Shared utilities for request handlers.
 * Contains common functions used by both OpenAI and Anthropic message handlers.
 */

import consola from "consola"

import type { OpenAIAutoTruncateResult } from "~/lib/auto-truncate-openai"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import {
  autoTruncateOpenAI,
  checkNeedsCompactionOpenAI,
  onRequestTooLarge,
} from "~/lib/auto-truncate-openai"
import { recordResponse } from "~/lib/history"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { requestTracker } from "~/lib/tui"

/** Context for recording responses and tracking */
export interface ResponseContext {
  historyId: string
  trackingId: string | undefined
  startTime: number
  truncateResult?: OpenAIAutoTruncateResult
  /** Time spent waiting in rate-limit queue (ms) */
  queueWaitMs?: number
}

/** Helper to update tracker model */
export function updateTrackerModel(
  trackingId: string | undefined,
  model: string,
) {
  if (!trackingId) return
  const request = requestTracker.getRequest(trackingId)
  if (request) request.model = model
}

/** Helper to update tracker status */
export function updateTrackerStatus(
  trackingId: string | undefined,
  status: "executing" | "streaming",
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, { status })
}

/** Record error response to history */
export function recordErrorResponse(
  ctx: ResponseContext,
  model: string,
  error: unknown,
) {
  recordResponse(
    ctx.historyId,
    {
      success: false,
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : "Unknown error",
      content: null,
    },
    Date.now() - ctx.startTime,
  )
}

/** Complete TUI tracking */
export function completeTracking(
  trackingId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  queueWaitMs?: number,
) {
  if (!trackingId) return
  requestTracker.updateRequest(trackingId, {
    inputTokens,
    outputTokens,
    queueWaitMs,
  })
  requestTracker.completeRequest(trackingId, 200, { inputTokens, outputTokens })
}

/** Fail TUI tracking */
export function failTracking(trackingId: string | undefined, error: unknown) {
  if (!trackingId) return
  requestTracker.failRequest(
    trackingId,
    error instanceof Error ? error.message : "Stream error",
  )
}

/** Minimal truncate result info needed for usage adjustment and markers */
export interface TruncateResultInfo {
  wasCompacted: boolean
  originalTokens?: number
  compactedTokens?: number
  removedMessageCount?: number
}

/**
 * Create a marker to prepend to responses indicating auto-truncation occurred.
 * Works with both OpenAI and Anthropic truncate results.
 */
export function createTruncationMarker(result: TruncateResultInfo): string {
  if (!result.wasCompacted) return ""

  const { originalTokens, compactedTokens, removedMessageCount } = result

  if (
    originalTokens === undefined
    || compactedTokens === undefined
    || removedMessageCount === undefined
  ) {
    return `\n\n---\n[Auto-truncated: conversation history was reduced to fit context limits]`
  }

  const reduction = originalTokens - compactedTokens
  const percentage = Math.round((reduction / originalTokens) * 100)

  return (
    `\n\n---\n[Auto-truncated: ${removedMessageCount} messages removed, `
    + `${originalTokens} → ${compactedTokens} tokens (${percentage}% reduction)]`
  )
}

/** Base accumulator interface for stream error recording */
interface BaseStreamAccumulator {
  model: string
}

/** Record streaming error to history (works with any accumulator type) */
export function recordStreamError(opts: {
  acc: BaseStreamAccumulator
  fallbackModel: string
  ctx: ResponseContext
  error: unknown
}) {
  const { acc, fallbackModel, ctx, error } = opts
  recordResponse(
    ctx.historyId,
    {
      success: false,
      model: acc.model || fallbackModel,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : "Stream error",
      content: null,
    },
    Date.now() - ctx.startTime,
  )
}

/** Type guard for non-streaming responses */
export function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<unknown>,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}

/** Build final payload with auto-truncate if needed */
export async function buildFinalPayload(
  payload: ChatCompletionsPayload,
  model: Parameters<typeof checkNeedsCompactionOpenAI>[1] | undefined,
): Promise<{
  finalPayload: ChatCompletionsPayload
  truncateResult: OpenAIAutoTruncateResult | null
}> {
  if (!state.autoTruncate || !model) {
    if (state.autoTruncate && !model) {
      consola.warn(
        `Auto-truncate: Model '${payload.model}' not found in cached models, skipping`,
      )
    }
    return { finalPayload: payload, truncateResult: null }
  }

  try {
    const check = await checkNeedsCompactionOpenAI(payload, model)
    consola.debug(
      `Auto-truncate check: ${check.currentTokens} tokens (limit ${check.tokenLimit}), `
        + `${Math.round(check.currentBytes / 1024)}KB (limit ${Math.round(check.byteLimit / 1024)}KB), `
        + `needed: ${check.needed}${check.reason ? ` (${check.reason})` : ""}`,
    )
    if (!check.needed) {
      return { finalPayload: payload, truncateResult: null }
    }

    let reasonText: string
    if (check.reason === "both") {
      reasonText = "tokens and size"
    } else if (check.reason === "bytes") {
      reasonText = "size"
    } else {
      reasonText = "tokens"
    }
    consola.info(`Auto-truncate triggered: exceeds ${reasonText} limit`)
    const truncateResult = await autoTruncateOpenAI(payload, model)
    return { finalPayload: truncateResult.payload, truncateResult }
  } catch (error) {
    // Auto-truncate is a best-effort optimization; if it fails, proceed with original payload
    // The request may still succeed if we're under the actual limit
    consola.warn(
      "Auto-truncate failed, proceeding with original payload:",
      error instanceof Error ? error.message : error,
    )
    return { finalPayload: payload, truncateResult: null }
  }
}

/**
 * Log helpful debugging information when a 413 error occurs.
 * Also adjusts the dynamic byte limit for future requests.
 */
export async function logPayloadSizeInfo(
  payload: ChatCompletionsPayload,
  model: Model | undefined,
) {
  const messageCount = payload.messages.length
  const bodySize = JSON.stringify(payload).length
  const bodySizeKB = Math.round(bodySize / 1024)

  // Adjust the dynamic byte limit for future requests
  onRequestTooLarge(bodySize)

  // Count images and large messages
  let imageCount = 0
  let largeMessages = 0
  let totalImageSize = 0

  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url") {
          imageCount++
          if (part.image_url.url.startsWith("data:")) {
            totalImageSize += part.image_url.url.length
          }
        }
      }
    }

    const msgSize =
      typeof msg.content === "string" ?
        msg.content.length
      : JSON.stringify(msg.content).length
    if (msgSize > 50000) largeMessages++
  }

  consola.info("")
  consola.info("╭─────────────────────────────────────────────────────────╮")
  consola.info("│           413 Request Entity Too Large                  │")
  consola.info("╰─────────────────────────────────────────────────────────╯")
  consola.info("")
  consola.info(
    `  Request body size: ${bodySizeKB} KB (${bodySize.toLocaleString()} bytes)`,
  )
  consola.info(`  Message count: ${messageCount}`)

  if (model) {
    try {
      const tokenCount = await getTokenCount(payload, model)
      const limit = model.capabilities?.limits?.max_prompt_tokens ?? 128000
      consola.info(
        `  Estimated tokens: ${tokenCount.input.toLocaleString()} / ${limit.toLocaleString()}`,
      )
    } catch {
      // Ignore token count errors
    }
  }

  if (imageCount > 0) {
    const imageSizeKB = Math.round(totalImageSize / 1024)
    consola.info(`  Images: ${imageCount} (${imageSizeKB} KB base64 data)`)
  }
  if (largeMessages > 0) {
    consola.info(`  Large messages (>50KB): ${largeMessages}`)
  }

  consola.info("")
  consola.info("  Suggestions:")
  if (!state.autoTruncate) {
    consola.info(
      "    • Enable --auto-truncate to automatically truncate history",
    )
  }
  if (imageCount > 0) {
    consola.info("    • Remove or resize large images in the conversation")
  }
  consola.info("    • Start a new conversation with /clear or /reset")
  consola.info("    • Reduce conversation history by deleting old messages")
  consola.info("")
}
