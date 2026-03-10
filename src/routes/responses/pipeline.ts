/**
 * Shared pipeline configuration for the Responses API.
 *
 * Both the HTTP handler (handler.ts) and WebSocket handler (ws.ts)
 * use identical adapter and strategy configuration. This module
 * centralizes that configuration to avoid duplication.
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { createResponses } from "~/lib/openai/responses-client"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"

/** Create the FormatAdapter for Responses API pipeline execution */
export function createResponsesAdapter(selectedModel?: Model): FormatAdapter<ResponsesPayload> {
  return {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, removedCount: 0, systemReminderRemovals: 0 }),
    execute: (p) => executeWithAdaptiveRateLimit(() => createResponses(p, { resolvedModel: selectedModel })),
    logPayloadSize: (p) => {
      const count = typeof p.input === "string" ? 1 : p.input.length
      consola.debug(`Responses payload: ${count} input item(s), model: ${p.model}`)
    },
  }
}

/** Create the retry strategies for Responses API pipeline execution */
export function createResponsesStrategies() {
  return [createNetworkRetryStrategy<ResponsesPayload>(), createTokenRefreshStrategy<ResponsesPayload>()]
}
