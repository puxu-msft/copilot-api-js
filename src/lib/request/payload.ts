/**
 * Payload utilities for request handlers.
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { getTokenCount } from "~/lib/models/tokenizer"
import { bytesToKB } from "~/lib/utils"

/**
 * Log helpful debugging information when a 413 error occurs.
 *
 * @param precomputedBytes - Optional pre-computed payload byte size to avoid redundant JSON.stringify
 */
export async function logPayloadSizeInfo(
  payload: ChatCompletionsPayload,
  model: Model | undefined,
  precomputedBytes?: number,
) {
  const messageCount = payload.messages.length
  const bodySize = precomputedBytes ?? JSON.stringify(payload).length
  const bodySizeKB = bytesToKB(bodySize)

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

/** Log payload size info for Anthropic format when a 413 error occurs */
export function logPayloadSizeInfoAnthropic(payload: MessagesPayload, model: Model | undefined) {
  const payloadSize = JSON.stringify(payload).length
  const messageCount = payload.messages.length
  const toolCount = payload.tools?.length ?? 0
  const systemSize = payload.system ? JSON.stringify(payload.system).length : 0

  consola.info(
    `[Anthropic 413] Payload size: ${bytesToKB(payloadSize)}KB, `
      + `messages: ${messageCount}, tools: ${toolCount}, system: ${bytesToKB(systemSize)}KB`,
  )

  if (model?.capabilities?.limits) {
    const limits = model.capabilities.limits
    consola.info(
      `[Anthropic 413] Model limits: context=${limits.max_context_window_tokens}, `
        + `prompt=${limits.max_prompt_tokens}, output=${limits.max_output_tokens}`,
    )
  }
}
