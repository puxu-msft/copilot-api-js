/**
 * The shared CC-family leg strategy dispatcher (RFC 2026-07-13 §11.3) — the strategy STACK's shape is a
 * function of BOTH axes, so the `/chat/completions` + `/responses` legs (which each serve multiple client
 * formats) select the stack by the composed {@link RetrySemanticsSpec}'s `autoTruncate` flag:
 *
 *   - `autoTruncate: false` (the openai-responses DIRECT/FALLBACK cells, R1/HIGH-A corner) → the Responses
 *     stack (network → server-error → token-refresh, NO auto-truncate, maxRetries 1). `originalPayload` is
 *     `env.body` (Responses-shaped: direct is identity; the fallback's Responses→CC happens in prepareWire,
 *     so the strategy still sees the Responses body — matching the legacy `buildOpenAiResponsesStrategiesForEnv`).
 *   - `autoTruncate: true` (openai-cc DIRECT + anthropic/gemini FORWARD, incl. via-responses) → the CC stack
 *     (+ auto-truncate). anthropic FORWARD uses `env.body` (the hub-translated CC body — matching the messages
 *     handler); openai-cc/gemini use `requestState.truncateBaseline` (the parse-captured CC baseline).
 *
 * Byte-equivalent to the per-route strategy factories the handlers pass today (chat/responses/gemini/ws).
 */

import type { Model } from "~/lib/models/client"
import type { RetrySemanticsSpec } from "~/lib/pipeline/cell-assembly"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy } from "~/lib/pipeline/types"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { buildOpenAiCcStrategies } from "./openai-cc/strategies"
import { buildOpenAiResponsesStrategies } from "./openai-responses/strategies"

/** Build the retry stack for a CC-family leg cell (`/chat` or `/responses`), dispatched by `spec.autoTruncate`. */
export function buildCcFamilyLegStrategies(spec: RetrySemanticsSpec, env: RequestEnvelope): ReadonlyArray<RetryStrategy> {
  const model = env.model as Model | undefined
  if (!spec.autoTruncate) {
    // openai-responses DIRECT/FALLBACK: the Responses stack (no auto-truncate, maxRetries 1). env.body is
    // Responses-shaped (direct identity; fallback translation deferred to prepareWire).
    return buildOpenAiResponsesStrategies({ originalPayload: env.body as ResponsesPayload, model, maxRetries: spec.maxRetries })
  }
  // openai-cc DIRECT + anthropic/gemini FORWARD (incl. via-responses): the CC stack against the CC baseline.
  const originalPayload =
    env.clientFormat === "anthropic" ?
      (env.body as ChatCompletionsPayload)
    : ((env.requestState?.truncateBaseline as ChatCompletionsPayload | undefined) ?? (env.body as ChatCompletionsPayload))
  return buildOpenAiCcStrategies({ originalPayload, model, maxRetries: spec.maxRetries, label: spec.label })
}
