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

import { adaptPayloadStrategy } from "~/lib/pipeline/payload-strategy-adapter"
import { createAdaptiveThinkingRejectionRetryStrategy } from "~/lib/request/strategies/adaptive-thinking-rejection-retry"
import { createCacheControlSubfieldRejectionStrategy } from "~/lib/request/strategies/cache-control-subfield-rejection-retry"
import { createBodyFieldRejectionStrategy } from "~/lib/request/strategies/context-management-retry"
import { createDeferredToolRetryStrategy } from "~/lib/request/strategies/deferred-tool-retry"
import { createEffortLearningRetryStrategy } from "~/lib/request/strategies/effort-learning-retry"
import { createLegacyThinkingRetryStrategy } from "~/lib/request/strategies/legacy-thinking-retry"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"
import { createServerToolRejectionStrategy } from "~/lib/request/strategies/server-tool-rejection-retry"
import { createStructuredOutputsRejectionStrategy } from "~/lib/request/strategies/structured-outputs-rejection-retry"
import { createSystemRejectRetryStrategy } from "~/lib/request/strategies/system-reject-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { createToolFieldRejectionStrategy } from "~/lib/request/strategies/tool-field-rejection-retry"
import { createUnsupportedBetaRetryStrategy } from "~/lib/request/strategies/unsupported-beta-retry"
import { createWebSearchNotFoundRetryStrategy } from "~/lib/request/strategies/web-search-not-found-retry"

import { createPoisonedThinkingRetryStrategy } from "./poisoned-thinking-retry"

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

/** Build the ordered env-based Anthropic retry strategies for one request. */
export function buildAnthropicStrategies(deps: AnthropicStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  const attemptRef = { value: 0 }
  const adapt = <T>(payloadStrategy: Parameters<typeof adaptPayloadStrategy<T>>[0]): EnvRetryStrategy =>
    adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: deps.originalPayload as T, model: deps.model, maxRetries: deps.maxRetries })

  return [
    adapt(createNetworkRetryStrategy<MessagesPayload>()),
    adapt(createServerErrorRetryStrategy<MessagesPayload>()),
    adapt(createTokenRefreshStrategy<MessagesPayload>()),
    adapt(createEffortLearningRetryStrategy<MessagesPayload>()),
    // tool-field-rejection BEFORE body-field: both match `... : Extra inputs are
    // not permitted`, but tool-field claims the dotted `tools.N.<variant>.<field>`
    // shape (body-field's tightened lookbehind now excludes dotted paths — this
    // ordering is defense-in-depth against that coupling).
    adapt(createToolFieldRejectionStrategy<MessagesPayload>()),
    adapt(createBodyFieldRejectionStrategy<MessagesPayload>()),
    // cache_control 子字段 rejection：也 match `... : Extra inputs are not permitted`，但正则要求
    // 四段 `.cache_control.<variant>.<field>:`（disjoint 于 tool-field 的 tools.N.<f>: 与 body-field
    // 的 top-level lookbehind，三路径遮蔽由回归测试证实）。排在两者之后作 defense-in-depth。
    adapt(createCacheControlSubfieldRejectionStrategy<MessagesPayload>()),
    adapt(createLegacyThinkingRetryStrategy<MessagesPayload>()),
    // Mirror of legacy-thinking: reactive net for the reverse 400 ("adaptive
    // thinking is not supported on this model"). Matcher is disjoint from
    // legacy-thinking's `thinking.type.enabled`, so this position is order-safe.
    adapt(createAdaptiveThinkingRejectionRetryStrategy<MessagesPayload>()),
    // L2 poisoned-thinking strip-all retry — NATIVE env-strategy, deliberately NOT
    // adapt()-wrapped: L3 (Task 10) reads `env.ctx` in onResolved, which the payload
    // adapter drops. Its matcher requires "cannot be modified" (disjoint from
    // legacy-thinking's "thinking.type.enabled"), so this position among the
    // 400-class handlers is order-safe.
    createPoisonedThinkingRetryStrategy(),
    adapt(createUnsupportedBetaRetryStrategy<MessagesPayload>({ getProbeCandidates: () => deps.betaProbe.getCandidates() })),
    adapt(createServerToolRejectionStrategy<MessagesPayload>()),
    adapt(createStructuredOutputsRejectionStrategy<MessagesPayload>()),
    adapt(createSystemRejectRetryStrategy<MessagesPayload>({ resanitize: deps.resanitize })),
    adapt(createWebSearchNotFoundRetryStrategy<MessagesPayload>({ resanitize: deps.resanitize })),
    adapt(createDeferredToolRetryStrategy<MessagesPayload>()),
  ]
}
