/**
 * v4 pipeline — openai-cc env-based retry strategies.
 *
 * Mirrors the legacy `createChatCompletionsStrategies` (routes/chat-completions/
 * handler.ts) but yields driver-shaped env strategies, by wrapping the unchanged
 * legacy strategies (network-retry → token-refresh → auto-truncate) in
 * {@link adaptLegacyStrategy}. **v4-only addition**: `server-error-retry`
 * (bounded backoff for upstream 5xx) is inserted right after `network-retry`,
 * absent from the legacy pipeline. Effective order:
 * network → server-error → token-refresh → auto-truncate (per-strategy logic of
 * the legacy ones stays byte-identical, 02 §1.2).
 *
 * Per-request factory: the route builds these once per request, closing over the
 * **truncation baseline** (`originalPayload` — the un-sanitized, post-tool-rename
 * payload the legacy auto-truncate re-truncates from each retry, never the mutated
 * `env.body`). The auto-truncate `truncateResult` reaches the response side via the
 * driver's post-gate `onMeta` sink (C0-② / RFC §11.2), not a strategy-level
 * callback — so a budget-rejected truncate retry no longer records a phantom marker.
 */

import type { Model } from "~/lib/models/client"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"
import type { TruncateResult } from "~/lib/request/strategies/auto-truncate"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { getTokenCount } from "~/lib/models/tokenizer"
import { autoTruncateOpenAI } from "~/lib/openai/auto-truncate"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { adaptLegacyStrategy } from "~/lib/pipeline/legacy-strategy-adapter"
import { createAutoTruncateStrategy } from "~/lib/request/strategies/auto-truncate"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { state } from "~/lib/state"

export interface OpenAiCcStrategiesDeps {
  /** Truncation baseline: the un-sanitized, post-tool-rename payload (stable across retries). */
  originalPayload: ChatCompletionsPayload
  /** Resolved model (auto-truncate needs it; network/token-refresh ignore it). */
  model: Model | undefined
  /** Normal-retry budget (`state.maxReactiveRetries`). */
  maxRetries: number
  /** Console label for the retry log lines (e.g. "Completions" / "Completions(→Responses)"). */
  label: string
}

/** Build the ordered env-based CC retry strategies for one request. */
export function buildOpenAiCcStrategies(deps: OpenAiCcStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  const attemptRef = { value: 0 }
  const adapt = <T>(legacy: Parameters<typeof adaptLegacyStrategy<T>>[0]): EnvRetryStrategy =>
    adaptLegacyStrategy(legacy, { attemptRef, originalPayload: deps.originalPayload as T, model: deps.model, maxRetries: deps.maxRetries })

  return [
    adapt(createNetworkRetryStrategy<ChatCompletionsPayload>()),
    adapt(createServerErrorRetryStrategy<ChatCompletionsPayload>()),
    adapt(createTokenRefreshStrategy<ChatCompletionsPayload>()),
    adapt(
      createAutoTruncateStrategy<ChatCompletionsPayload>({
        truncate: (p, model, truncOpts) => autoTruncateOpenAI(p, model, truncOpts) as Promise<TruncateResult<ChatCompletionsPayload>>,
        resanitize: (p) => sanitizeOpenAIMessages(p),
        countTokens: async (p, model) => (await getTokenCount(p, model)).input,
        isEnabled: () => state.autoTruncate,
        label: deps.label,
      }),
    ),
  ]
}
