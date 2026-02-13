/**
 * Payload utilities for request handlers.
 */

import consola from "consola"

import type { OpenAIAutoTruncateResult } from "~/lib/auto-truncate/openai"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { onRequestTooLarge } from "~/lib/auto-truncate/openai"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { getTokenCount } from "~/lib/models/tokenizer"
import { bytesToKB } from "~/lib/utils"

/** Build final payload with sanitization (no pre-truncation — truncation is now reactive) */
export function buildFinalPayload(
  payload: ChatCompletionsPayload,
  _model: Model | undefined,
): {
  finalPayload: ChatCompletionsPayload
  truncateResult: OpenAIAutoTruncateResult | null
  sanitizeRemovedCount: number
  systemReminderRemovals: number
} {
  // Sanitize messages to filter orphaned tool/tool_result messages
  const {
    payload: sanitizedPayload,
    removedCount: sanitizeRemovedCount,
    systemReminderRemovals,
  } = sanitizeOpenAIMessages(payload)

  return {
    finalPayload: sanitizedPayload,
    truncateResult: null, // Truncation is now handled reactively in the retry loop
    sanitizeRemovedCount,
    systemReminderRemovals,
  }
}

/**
 * Log helpful debugging information when a 413 error occurs.
 * Also adjusts the dynamic byte limit for future requests.
 */
export async function logPayloadSizeInfo(payload: ChatCompletionsPayload, model: Model | undefined) {
  const messageCount = payload.messages.length
  const bodySize = JSON.stringify(payload).length
  const bodySizeKB = bytesToKB(bodySize)

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

    const msgSize = typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length
    if (msgSize > 50000) largeMessages++
  }

  consola.info("")
  consola.info("╭─────────────────────────────────────────────────────────╮")
  consola.info("│           413 Request Entity Too Large                  │")
  consola.info("╰─────────────────────────────────────────────────────────╯")
  consola.info("")
  consola.info(`  Request body size: ${bodySizeKB} KB (${bodySize.toLocaleString()} bytes)`)
  consola.info(`  Message count: ${messageCount}`)

  if (model) {
    try {
      const tokenCount = await getTokenCount(payload, model)
      const limit = model.capabilities?.limits?.max_prompt_tokens ?? 128000
      consola.info(`  Estimated tokens: ${tokenCount.input.toLocaleString()} / ${limit.toLocaleString()}`)
    } catch (error) {
      consola.debug("Token count estimation failed:", error)
    }
  }

  if (imageCount > 0) {
    const imageSizeKB = bytesToKB(totalImageSize)
    consola.info(`  Images: ${imageCount} (${imageSizeKB} KB base64 data)`)
  }
  if (largeMessages > 0) {
    consola.info(`  Large messages (>50KB): ${largeMessages}`)
  }

  consola.info("")
  consola.info("  Suggestions:")
  if (imageCount > 0) {
    consola.info("    • Remove or resize large images in the conversation")
  }
  consola.info("    • Start a new conversation with /clear or /reset")
  consola.info("    • Reduce conversation history by deleting old messages")
  consola.info("")
}
