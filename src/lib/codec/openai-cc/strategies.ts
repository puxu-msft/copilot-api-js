/**
 * v4 pipeline — openai-cc env-based retry strategies.
 *
 * Preserves the pre-driver Chat Completions strategy order but yields driver-shaped env strategies, by wrapping the unchanged
 * payload strategies (network-retry → token-refresh) in {@link adaptPayloadStrategy}.
 * **v4-only addition**: `server-error-retry` (bounded backoff for upstream 5xx) is
 * inserted right after `network-retry`, absent from the pre-driver executor. Effective
 * order: network → server-error → token-refresh (the payload strategy logic stays byte-identical, 02 §1.2).
 *
 * Per-request factory: the route builds these once per request, closing over the
 * **retry baseline** (`originalPayload` — the un-sanitized, post-tool-rename payload
 * each reactive retry re-derives from, never the mutated `env.body`).
 */

import type { Model } from "~/lib/models/client"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { adaptPayloadStrategy } from "~/lib/pipeline/payload-strategy-adapter"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"

export interface OpenAiCcStrategiesDeps {
  /** Retry baseline: the un-sanitized, post-tool-rename payload (stable across retries). */
  originalPayload: ChatCompletionsPayload
  /** Resolved model (network/token-refresh ignore it; kept for parity with the anthropic factory). */
  model: Model | undefined
  /** Shared reactive-retry budget (`state.maxReactiveRetries`). */
  maxRetries: number
  /** Console label for the retry log lines (e.g. "Completions" / "Completions(→Responses)"). */
  label: string
}

/** Build the ordered env-based CC retry strategies for one request. */
export function buildOpenAiCcStrategies(deps: OpenAiCcStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  const attemptRef = { value: 0 }
  const adapt = <T>(payloadStrategy: Parameters<typeof adaptPayloadStrategy<T>>[0]): EnvRetryStrategy =>
    adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: deps.originalPayload as T, model: deps.model, maxRetries: deps.maxRetries })

  return [
    adapt(createNetworkRetryStrategy<ChatCompletionsPayload>()),
    adapt(createServerErrorRetryStrategy<ChatCompletionsPayload>()),
    adapt(createTokenRefreshStrategy<ChatCompletionsPayload>()),
  ]
}
