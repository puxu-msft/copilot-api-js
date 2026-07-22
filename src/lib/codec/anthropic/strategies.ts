/**
 * v4 pipeline — anthropic-messages env-based retry strategies (P2.6 / C2).
 *
 * Mirrors the pre-driver `buildAnthropicStrategies` (anthropic/pipeline.ts) by wrapping
 * the unchanged payload strategies in {@link adaptPayloadStrategy}. The payload
 * strategies keep their exact order + per-strategy logic (RFC §12.9):
 *
 *   network → token-refresh → effort-learning → body-field → legacy-thinking →
 *   adaptive-thinking-rejection → unsupported-beta → deferred-tool
 *
 * **v4-only additions** — strategies absent from the pre-driver executor
 * (intentional divergence, 16 strategies total):
 *   - `server-error-retry` — bounded backoff for upstream 5xx, inserted right
 *     after `network-retry` (before `token-refresh`).
 *   - `tool-field-rejection` — learns unknown custom-tool top-level fields the
 *     upstream rejects with 400 `tools.N.<variant>.<field>: Extra inputs are not
 *     permitted` (e.g. `eager_input_streaming`), fixates them endpoint-wide, and
 *     strips them on retry. Inserted BEFORE `body-field-rejection` (both match
 *     `Extra inputs are not permitted`; ordering is defense-in-depth).
 *   - two reactive feature-strip strategies inserted between unsupported-beta
 *     and deferred-tool:
 *   - `server-tool-rejection` — learns native server tools (web_search) the
 *     upstream rejects with 400 `The use of the web search tool is not
 *     supported.`, fixates them in the negotiation cache, and strips them on
 *     retry via `PrepareHints.excludeServerToolTypes`.
 *   - `structured-outputs-rejection` — learns the `structured_outputs` partner
 *     feature when a Vertex org policy
 *     (`constraints/vertexai.allowedPartnerModelFeatures`) disallows it with a
 *     400, fixates it in the negotiation cache, and strips
 *     `output_config.format` on retry (and pre-emptively in prepare).
 *
 * Unlike openai-cc (4 strategies), Anthropic has extra 400-class strategies
 * (effort-learning, tool-field-rejection, body-field, legacy-thinking,
 * unsupported-beta, server-tool-rejection, structured-outputs-rejection) — do
 * not drop any. The
 * `betaProbe` is the SAME instance the codec records outbound betas into (RFC
 * §2.4 cross-component handle): the unsupported-beta strategy reads its
 * candidates for the laconic `invalid beta flag` path.
 *
 * Per-request factory: the handler builds these once per request, closing over the
 * retry baseline (`originalPayload` = codec.getTruncateBaseline()) + the
 * resanitize chain (codec.getResanitize()).
 */

import type {
  //
  AnthropicSanitizeFn,
  BetaProbe,
} from "~/lib/anthropic/pipeline"
import type { Model } from "~/lib/models/client"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { ENDPOINT } from "~/lib/models/endpoint"
import { assembleRetryStrategies } from "~/lib/request/retry-registry"
import { state } from "~/lib/state"

export interface AnthropicStrategiesDeps {
  /** Retry baseline: the preprocessed, pre-initial-sanitize payload (= codec.getTruncateBaseline()). */
  originalPayload: MessagesPayload
  /** The direct sanitize chain reused as the reactive-retry resanitize (= codec.getResanitize()). */
  resanitize: AnthropicSanitizeFn
  /** Resolved model (passed to the adapters; most strategies ignore it). */
  model: Model | undefined
  /** Shared reactive-retry budget (`state.maxReactiveRetries`). */
  maxRetries: number
  /** The shared per-request beta probe (also injected into the codec). */
  betaProbe: BetaProbe
}

/**
 * Build the ordered env-based Anthropic retry strategies for one request — a thin delegation to the
 * declarative {@link assembleRetryStrategies} (registry Task 3 / RFC §3.2). `targetEndpoint` is hard-coded
 * to `ENDPOINT.MESSAGES` (this factory only ever serves `@messages` cells — direct anthropic AND the 3
 * reverse legs via `anthropicMessagesLeg.buildLegStrategies`, RFC §3.3); `clientFormat` is `"anthropic"`
 * as a placeholder for the assembler's `RetryStrategyContext` — the registry's `appliesTo` gates purely on
 * `targetEndpoint`, never `clientFormat` (RFC §3.3, load-bearing), so this value never changes which
 * strategies assemble for the reverse legs (golden `tests/pipeline/retry-strategy-assembly.golden.it.test.ts`
 * proves the 16-name order is identical for all 4 `@messages` callers).
 *
 * `config` is `state.retryStrategies` (Task 4 / RFC §3.4 — per-strategy `retry.strategies.<configKey>.enabled`
 * opt-out, read fresh per request so hot-reload takes effect on the next request; default `{}` = all 16 on,
 * byte-equivalent to the pre-config-switch behavior).
 */
export function buildAnthropicStrategies(deps: AnthropicStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  return assembleRetryStrategies(
    { clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES },
    {
      attemptRef: { value: 0 },
      originalPayload: deps.originalPayload,
      model: deps.model,
      maxRetries: deps.maxRetries,
      betaProbe: deps.betaProbe,
      resanitize: deps.resanitize,
    },
    state.retryStrategies,
  )
}
