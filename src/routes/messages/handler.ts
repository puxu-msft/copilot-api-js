/**
 * Main handler for Anthropic /v1/messages endpoint.
 * Routes requests to appropriate handlers based on model type.
 */

import type { Context } from "hono"

import consola from "consola"

import type { AnthropicMessagesPayload } from "~/types/api/anthropic"

import { recordRequest } from "~/lib/history"
import { requestTracker } from "~/lib/tui"
import { supportsDirectAnthropicApi } from "~/services/copilot/create-anthropic-messages"

import { type ResponseContext, updateTrackerModel } from "../shared"
import { handleDirectAnthropicCompletion } from "./direct-anthropic-handler"
import { convertAnthropicMessages, extractSystemPrompt } from "./message-utils"
import { handleTranslatedCompletion } from "./translated-handler"

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Log tool-related information for debugging
  logToolInfo(anthropicPayload)

  // Determine which path we'll use
  const useDirectAnthropicApi = supportsDirectAnthropicApi(
    anthropicPayload.model,
  )

  // Get tracking ID and use tracker's startTime for consistent timing
  const trackingId = c.get("trackingId") as string | undefined
  const trackedRequest =
    trackingId ? requestTracker.getRequest(trackingId) : undefined
  const startTime = trackedRequest?.startTime ?? Date.now()

  // Update TUI tracker with model info
  updateTrackerModel(trackingId, anthropicPayload.model)

  // Record request to history with full message content
  const historyId = recordRequest("anthropic", {
    model: anthropicPayload.model,
    messages: convertAnthropicMessages(anthropicPayload.messages),
    stream: anthropicPayload.stream ?? false,
    tools: anthropicPayload.tools?.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    max_tokens: anthropicPayload.max_tokens,
    temperature: anthropicPayload.temperature,
    system: extractSystemPrompt(anthropicPayload.system),
  })

  const ctx: ResponseContext = { historyId, trackingId, startTime }

  // Route to appropriate handler based on model type
  if (useDirectAnthropicApi) {
    return handleDirectAnthropicCompletion(c, anthropicPayload, ctx)
  }

  // Fallback to OpenAI translation path
  return handleTranslatedCompletion(c, anthropicPayload, ctx)
}

/**
 * Log tool-related information for debugging
 */
function logToolInfo(anthropicPayload: AnthropicMessagesPayload) {
  if (anthropicPayload.tools?.length) {
    const toolInfo = anthropicPayload.tools.map((t) => ({
      name: t.name,
      type: t.type ?? "(custom)",
    }))
    consola.debug(`[Tools] Defined tools:`, JSON.stringify(toolInfo))
  }

  // Log tool_use and tool_result in messages for debugging
  for (const msg of anthropicPayload.messages) {
    if (typeof msg.content !== "string") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          consola.debug(
            `[Tools] tool_use in message: ${block.name} (id: ${block.id})`,
          )
        }
        if (block.type === "tool_result") {
          consola.debug(
            `[Tools] tool_result in message: id=${block.tool_use_id}, is_error=${block.is_error ?? false}`,
          )
        }
      }
    }
  }
}
