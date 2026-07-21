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

import { ENDPOINT } from "~/lib/models/endpoint"
import { assembleRetryStrategies } from "~/lib/request/retry-registry"

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

/**
 * Build the ordered env-based CC retry strategies for one request — thin delegation to the declarative
 * {@link assembleRetryStrategies} (registry Task 3 / RFC §3.2). `targetEndpoint` is `ENDPOINT.CHAT_COMPLETIONS`
 * (a non-`@messages` endpoint) so the registry's 13 anthropic-only entries never gate in — only the 3 shared
 * ones assemble (golden-proven). `betaProbe`/`resanitize` are omitted (`undefined`): the CC-family legs never
 * populate them, and none of the 3 shared entries need them. `deps.label` is unused by any assembled entry
 * (unchanged from before this refactor — the CC console-label consumer, `createAutoTruncateStrategy`, was
 * removed 2026-07-13 alongside auto-truncate; the field stays on the interface for the caller's parity/log
 * lines outside this factory, see `cc-family-strategies.ts`). `config` is `undefined` (Task 4 wires
 * `retry.strategies` — not yet).
 */
export function buildOpenAiCcStrategies(deps: OpenAiCcStrategiesDeps): ReadonlyArray<EnvRetryStrategy> {
  return assembleRetryStrategies(
    { clientFormat: "openai-cc", targetEndpoint: ENDPOINT.CHAT_COMPLETIONS },
    {
      attemptRef: { value: 0 },
      originalPayload: deps.originalPayload,
      model: deps.model,
      maxRetries: deps.maxRetries,
      betaProbe: undefined,
      resanitize: undefined,
    },
    undefined,
  )
}
