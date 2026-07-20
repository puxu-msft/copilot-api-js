/**
 * The shared CC-family leg strategy dispatcher (RFC 2026-07-13 §11.3) — the `/chat/completions` +
 * `/responses` legs each serve multiple client formats, so this picks the builder by clientFormat:
 *
 *   - `openai-responses` (DIRECT `/responses` + FALLBACK `/chat`) → `buildOpenAiResponsesStrategies` against
 *     the Responses-shaped `env.body` (direct identity; the fallback's Responses→CC happens in prepareWire,
 *     so the strategy still sees the Responses body — matching the legacy `buildOpenAiResponsesStrategiesForEnv`).
 *   - `openai-cc` DIRECT + `gemini` FORWARD (incl. via-responses) → `buildOpenAiCcStrategies` against the
 *     CC-shaped body: openai-cc/gemini use `requestState.truncateBaseline` (the parse-captured CC baseline).
 *   - `anthropic` FORWARD `@cc` → `buildOpenAiCcStrategies` against `env.body` (the hub-translated CC body).
 *   - `anthropic` FORWARD `@responses` (RFC 2026-07-14-anthropic-responses-direct-bridge §3 DIRECT bridge) →
 *     `buildOpenAiResponsesStrategies` against `env.body` — the hub's `translateOut` produces a
 *     Responses-shaped body DIRECTLY for this leg (no CC intermediate), so the retry baseline must be the
 *     Responses stack/shape too, else a reactive retry would replay a CC-shaped payload against a Responses
 *     wire (RFC §2.3 three-point corner: this dispatcher, the leg's `prepareWire`, and the hub bridge table
 *     entry were all updated together).
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

import { ENDPOINT } from "~/lib/models/endpoint"

import { buildOpenAiCcStrategies } from "./openai-cc/strategies"
import { buildOpenAiResponsesStrategies } from "./openai-responses/strategies"

/**
 * Is this the anthropic-client DIRECT-bridge `@responses` cell (Responses-shaped env.body, no CC hop)?
 * Same underlying condition as `openai-responses-cell.ts`'s `bodyIsResponsesShaped` restricted to the
 * anthropic clientFormat (this dispatcher's `openai-responses` branch above already covers that format).
 */
function isAnthropicDirectResponsesLeg(env: RequestEnvelope): boolean {
  return env.clientFormat === "anthropic" && (env.targetEndpoint === ENDPOINT.RESPONSES || env.targetEndpoint === ENDPOINT.WS_RESPONSES)
}

/** Build the retry stack for a CC-family leg cell (`/chat` or `/responses`), dispatched by clientFormat. */
export function buildCcFamilyLegStrategies(spec: RetrySemanticsSpec, env: RequestEnvelope): ReadonlyArray<RetryStrategy> {
  const model = env.model as Model | undefined
  if (env.clientFormat === "openai-responses" || isAnthropicDirectResponsesLeg(env)) {
    // openai-responses DIRECT/FALLBACK + anthropic DIRECT-bridge @responses: the Responses stack against
    // the Responses-shaped env.body (direct identity for openai-responses; the anthropic direct bridge
    // produced this shape at translateOut — RFC 2026-07-14 §3).
    return buildOpenAiResponsesStrategies({ originalPayload: env.body as ResponsesPayload, model, maxRetries: spec.maxRetries })
  }
  // openai-cc DIRECT + anthropic FORWARD @cc + gemini FORWARD (incl. via-responses): the CC stack against the CC baseline.
  const originalPayload =
    env.clientFormat === "anthropic" ?
      (env.body as ChatCompletionsPayload)
    : ((env.requestState?.truncateBaseline as ChatCompletionsPayload | undefined) ?? (env.body as ChatCompletionsPayload))
  return buildOpenAiCcStrategies({ originalPayload, model, maxRetries: spec.maxRetries, label: spec.label })
}
