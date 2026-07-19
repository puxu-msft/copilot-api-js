/**
 * v4 pipeline — openai-responses env-based retry strategies.
 *
 * Mirrors the pre-driver Responses retry-strategy set but yields driver-shaped env
 * strategies, by wrapping the unchanged payload strategies in
 * {@link adaptPayloadStrategy}. **v4-only addition**: `server-error-retry`
 * (bounded backoff for upstream 5xx) is inserted right after `network-retry`,
 * absent from the pre-driver executor. Effective order:
 * network → server-error → token-refresh (per-strategy logic of the payload strategies
 * stays byte-identical, 02 §1.2).
 *
 * Unlike CC, the Responses path has NO auto-truncate strategy
 * (retry-transport.md §2.2: `openai-responses: network → token-refresh`), so the
 * truncation baseline is irrelevant — the adapter just needs a stable
 * `originalPayload` for the payload `RetryContext` (network/token-refresh ignore
 * it). The env's current body serves.
 */

import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy as EnvRetryStrategy } from "~/lib/pipeline/types"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { adaptPayloadStrategy } from "~/lib/pipeline/payload-strategy-adapter"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createServerErrorRetryStrategy } from "~/lib/request/strategies/server-error-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"

export interface OpenAiResponsesStrategiesDeps {
  /** Stable baseline for the payload `RetryContext` (network/token-refresh ignore it). */
  originalPayload: ResponsesPayload
  /** Resolved model (network/token-refresh ignore it; carried for parity). */
  model: Model | undefined
  /** Normal-retry budget (pre-driver Responses used `maxRetries: 1`). */
  maxRetries: number
}

/** Build the ordered env-based Responses retry strategies for one request. */
export function buildOpenAiResponsesStrategies(deps: OpenAiResponsesStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  const attemptRef = { value: 0 }
  const adapt = <T>(payloadStrategy: Parameters<typeof adaptPayloadStrategy<T>>[0]): EnvRetryStrategy =>
    adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: deps.originalPayload as T, model: deps.model, maxRetries: deps.maxRetries })

  return [
    //
    adapt(createNetworkRetryStrategy<ResponsesPayload>()),
    adapt(createServerErrorRetryStrategy<ResponsesPayload>()),
    adapt(createTokenRefreshStrategy<ResponsesPayload>()),
  ]
}

/** Build the strategies from the parsed envelope (the driver's per-request factory form). */
export function buildOpenAiResponsesStrategiesForEnv(env: RequestEnvelope): ReadonlyArray<EnvRetryStrategy> {
  return buildOpenAiResponsesStrategies({
    originalPayload: env.body as ResponsesPayload,
    model: env.model as Model | undefined,
    maxRetries: 1,
  })
}
