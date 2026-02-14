import consola from "consola"
import { Hono } from "hono"

import type { MessagesPayload } from "~/types/api/anthropic"

import { handleAnthropicMessagesCompletion } from "~/lib/anthropic/handlers"
import { forwardError } from "~/lib/error"
import { translateModelName } from "~/lib/models/resolver"

import { handleCountTokens } from "./count-tokens-handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    const anthropicPayload = await c.req.json<MessagesPayload>()

    // Resolve model name aliases and date-suffixed versions
    // e.g., "haiku" → "claude-haiku-4.5", "claude-sonnet-4-20250514" → "claude-sonnet-4"
    const resolvedModel = translateModelName(anthropicPayload.model)
    if (resolvedModel !== anthropicPayload.model) {
      consola.debug(`Model name resolved: ${anthropicPayload.model} → ${resolvedModel}`)
      anthropicPayload.model = resolvedModel
    }

    return await handleAnthropicMessagesCompletion(c, anthropicPayload)
  } catch (error) {
    return forwardError(c, error)
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return forwardError(c, error)
  }
})
