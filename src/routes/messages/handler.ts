/**
 * Main handler for Anthropic /v1/messages endpoint.
 * Routes requests to appropriate handlers based on model type.
 */

import type { Context } from "hono"

import consola from "consola"

import type { MessagesPayload } from "~/types/api/anthropic"

import { type MessageContent, recordRequest } from "~/lib/history"
import { translateModelName } from "~/lib/models/resolver"
import { processAnthropicSystem } from "~/lib/system-prompt-manager"
import { tuiLogger } from "~/lib/tui"
import { supportsDirectAnthropicApi } from "~/services/copilot/create-anthropic-messages"

import { type ResponseContext } from "../shared"
import { handleDirectAnthropicCompletion } from "./direct-anthropic-handler"
import { handleTranslatedCompletion } from "./translated-handler"

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<MessagesPayload>()

  // Resolve model name aliases and date-suffixed versions
  // e.g., "haiku" → "claude-haiku-4.5", "claude-sonnet-4-20250514" → "claude-sonnet-4"
  const resolvedModel = translateModelName(anthropicPayload.model)
  if (resolvedModel !== anthropicPayload.model) {
    consola.debug(`Model name resolved: ${anthropicPayload.model} → ${resolvedModel}`)
    anthropicPayload.model = resolvedModel
  }

  // System prompt collection + config-based overrides (always active)
  if (anthropicPayload.system) {
    anthropicPayload.system = await processAnthropicSystem(anthropicPayload.system)
  }

  // Log tool-related information for debugging
  // logToolInfo(anthropicPayload)

  // Record request to history with full message content
  const historyId = recordRequest("anthropic", {
    model: anthropicPayload.model,
    messages: anthropicPayload.messages as unknown as MessageContent[],
    stream: anthropicPayload.stream ?? false,
    tools: anthropicPayload.tools?.map((t) => ({
      name: t.name,
      description: t.description,
    })),
    max_tokens: anthropicPayload.max_tokens,
    temperature: anthropicPayload.temperature,
    system: anthropicPayload.system,
  })

  // Get tracking ID and use tracker's startTime for consistent timing
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Update TUI tracker with model info
  if (tuiLogId) tuiLogger.updateRequest(tuiLogId, { model: anthropicPayload.model })

  const tuiLogEntry = tuiLogId ? tuiLogger.getRequest(tuiLogId) : undefined
  const startTime = tuiLogEntry?.startTime ?? Date.now()
  const ctx: ResponseContext = { historyId, tuiLogId, startTime }

  // Use direct Anthropic API or fallback to OpenAI translation
  const useDirectAnthropicApi = supportsDirectAnthropicApi(anthropicPayload.model)
  if (useDirectAnthropicApi) {
    return handleDirectAnthropicCompletion(c, anthropicPayload, ctx)
  } else {
    return handleTranslatedCompletion(c, anthropicPayload, ctx)
  }
}
