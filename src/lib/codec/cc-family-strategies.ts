/**
 * The shared CC-family leg strategy dispatcher (RFC 2026-07-13 §11.3) — the `/chat/completions` +
 * `/responses` legs each serve multiple client formats, so this picks the builder by clientFormat:
 *
 *   - `openai-responses` (DIRECT `/responses` + FALLBACK `/chat`) → `buildOpenAiResponsesStrategies` against
 *     the Responses-shaped `env.body` (direct identity; the fallback's Responses→CC happens in prepareWire,
 *     so the strategy still sees the Responses body — matching the legacy `buildOpenAiResponsesStrategiesForEnv`).
 *   - `openai-cc` DIRECT + `anthropic`/`gemini` FORWARD (incl. via-responses) → `buildOpenAiCcStrategies`
 *     against the CC-shaped body: anthropic FORWARD uses `env.body` (the hub-translated CC body — matching
 *     the messages handler); openai-cc/gemini use `requestState.truncateBaseline` (the parse-captured CC baseline).
 *
 * Since master removed auto-truncate (2026-07-13), the two builders produce IDENTICAL strategy arrays
 * (network → server-error → token-refresh) — the dispatch now only keeps the retry baseline the right BODY
 * SHAPE (Responses vs CC) + the `spec.maxRetries`/`label` the composed {@link RetrySemanticsSpec} carries.
 * Byte-equivalent to the per-route strategy factories the master handlers pass (chat/responses/gemini/ws).
 */

import type { Model } from "~/lib/models/client"
import type { RetrySemanticsSpec } from "~/lib/pipeline/cell-assembly"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy } from "~/lib/pipeline/types"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { buildOpenAiCcStrategies } from "./openai-cc/strategies"
import { buildOpenAiResponsesStrategies } from "./openai-responses/strategies"

/** Build the retry stack for a CC-family leg cell (`/chat` or `/responses`), dispatched by clientFormat. */
export function buildCcFamilyLegStrategies(spec: RetrySemanticsSpec, env: RequestEnvelope): ReadonlyArray<RetryStrategy> {
  const model = env.model as Model | undefined
  if (env.clientFormat === "openai-responses") {
    // openai-responses DIRECT/FALLBACK: the Responses stack against the Responses-shaped env.body (direct
    // identity; fallback translation deferred to prepareWire). maxRetries 1 (from the spec).
    return buildOpenAiResponsesStrategies({ originalPayload: env.body as ResponsesPayload, model, maxRetries: spec.maxRetries })
  }
  // openai-cc DIRECT + anthropic/gemini FORWARD (incl. via-responses): the CC stack against the CC baseline.
  const originalPayload =
    env.clientFormat === "anthropic" ?
      (env.body as ChatCompletionsPayload)
    : ((env.requestState?.truncateBaseline as ChatCompletionsPayload | undefined) ?? (env.body as ChatCompletionsPayload))
  return buildOpenAiCcStrategies({ originalPayload, model, maxRetries: spec.maxRetries, label: spec.label })
}
