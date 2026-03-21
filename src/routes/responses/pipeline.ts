/**
 * Shared pipeline configuration for the Responses API.
 *
 * Both the HTTP handler (handler.ts) and WebSocket handler (ws.ts)
 * use identical adapter and strategy configuration. This module
 * centralizes that configuration to avoid duplication.
 */

import consola from "consola"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type { ResponsesInputItem, ResponsesPayload } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { createResponses } from "~/lib/openai/responses-client"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"

/** Create the FormatAdapter for Responses API pipeline execution */
export function createResponsesAdapter(
  selectedModel?: Model,
  headersCapture?: HeadersCapture,
): FormatAdapter<ResponsesPayload> {
  return {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    execute: (p) =>
      executeWithAdaptiveRateLimit(() => createResponses(p, { resolvedModel: selectedModel, headersCapture })),
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

// ============================================================================
// Call ID normalization
// ============================================================================

const CALL_PREFIX = "call_"
const FC_PREFIX = "fc_"

/**
 * Normalize function call IDs in Responses API input.
 * Converts Chat Completions format `call_xxx` IDs to Responses format `fc_xxx` IDs
 * on `function_call` and `function_call_output` items.
 */
export function normalizeCallIds(payload: ResponsesPayload): ResponsesPayload {
  if (typeof payload.input === "string") return payload

  let count = 0
  const normalizedInput = payload.input.map((item): ResponsesInputItem => {
    if (item.type !== "function_call" && item.type !== "function_call_output") return item

    const newItem = { ...item }
    if (newItem.id?.startsWith(CALL_PREFIX)) {
      newItem.id = FC_PREFIX + newItem.id.slice(CALL_PREFIX.length)
      count++
    }
    if (newItem.call_id?.startsWith(CALL_PREFIX)) {
      newItem.call_id = FC_PREFIX + newItem.call_id.slice(CALL_PREFIX.length)
      count++
    }
    return newItem
  })

  if (count === 0) return payload
  consola.debug(`[responses] Normalized ${count} call ID(s) (call_ → fc_)`)
  return { ...payload, input: normalizedInput }
}
