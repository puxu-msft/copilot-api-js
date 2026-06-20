/**
 * Shared pipeline configuration for the Responses API.
 *
 * Both the HTTP handler (handler.ts) and WebSocket handler (ws.ts)
 * use identical adapter and strategy configuration. This module
 * centralizes that configuration to avoid duplication.
 */

import consola from "consola"

import type {
  //
  HeadersCapture,
  WireRequest,
} from "~/lib/context/request"
import type { RequestTransport } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type {
  //
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { createResponses } from "~/lib/openai/responses-client"
import {
  //
  extractInputItems,
} from "~/lib/openai/responses-conversion"

// Re-export so existing import sites (`./pipeline`) keep working without churn.

/** Create the FormatAdapter for Responses API pipeline execution */
export function createResponsesAdapter(
  selectedModel?: Model,
  headersCapture?: HeadersCapture,
  onPrepared?: (request: WireRequest) => void,
  onTransport?: (transport: RequestTransport) => void,
  conversationId?: string,
  clientAbortSignal?: AbortSignal,
): FormatAdapter<ResponsesPayload> {
  return {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    // `_hints`: see PrepareHints in lib/request/pipeline.ts. Responses request
    // preparation does not yet consume hints; the argument is accepted (and
    // ignored) so any future hints-producing strategy explicitly documents
    // what it expects to land here.
    execute: (p, _hints) =>
      executeWithAdaptiveRateLimit(() =>
        createResponses(p, {
          resolvedModel: selectedModel,
          headersCapture,
          onTransport,
          conversationId,
          clientAbortSignal,
          onPrepared: ({ wire, headers }) => {
            onPrepared?.({
              model: typeof wire.model === "string" ? wire.model : p.model,
              messages: extractInputItems(wire.input),
              payload: wire,
              headers,
              format: "openai-responses",
            })
          },
        }),
      ),
    logPayloadSize: (p) => {
      const count = typeof p.input === "string" ? 1 : p.input.length
      consola.debug(`Responses payload: ${count} input item(s), model: ${p.model}`)
    },
  }
}

/** Create the retry strategies for Responses API pipeline execution */

export { extractInputItems, normalizeCallIds } from "~/lib/openai/responses-conversion"
