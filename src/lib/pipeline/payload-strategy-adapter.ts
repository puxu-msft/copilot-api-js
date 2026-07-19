/**
 * v4 pipeline — payload-strategy → envelope-strategy adapter.
 *
 * The driver's retry loop consumes env-based {@link EnvRetryStrategy} (handle
 * receives + returns the {@link RequestEnvelope}; retry-transport.md §2.1). The
 * payload-oriented strategies (network-retry / token-refresh / reactive rejection / …) are
 * the payload-based `RetryStrategy<TPayload>` (handle receives a payload +
 * a {@link RetryContext}, returns a payload-bearing action). This adapter bridges
 * the two **without rewriting** the strategy logic, so behavior stays byte-identical
 * while keeping the format-native strategy logic independent of envelope orchestration.
 *
 * Mapping:
 *   - `handle(error, env)` synthesizes a `RetryContext` from per-request closure
 *     state (the stable `originalPayload` baseline, `model`, `maxRetries`) + a
 *     shared `attempt` counter, runs the payload strategy `handle(error, env.body, ctx)`,
 *     then folds the payload action back: `retry.payload`/`prepareHints` → `env.with(...)`,
 *     `abort` → `{ kind: "abort" }`.
 *   - `action.meta` (e.g. unsupported-beta's
 *     `probedBetas`) is attached to the returned env-action's `meta` (NOT fired
 *     immediately) — the driver routes it post-budget-gate to the handler's
 *     onMeta sink + this strategy's onResolved (C0-② / RFC §11.2), so a
 *     budget-rejected retry never emits phantom pipeline-info.
 *
 * The `attempt` counter is **shared** across all adapted strategies of one request
 * (a `{ value }` ref the factory increments per handle), providing the shared 0-based execution index used in the strategies' log lines.
 */

import type { ApiError } from "~/lib/error"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RetryAction as EnvRetryAction,
  RetryStrategy as EnvRetryStrategy,
} from "~/lib/pipeline/types"
import type {
  //
  RetryContext,
  RetryStrategy as PayloadRetryStrategy,
} from "~/lib/request/retry-types"

/** Mutable shared attempt counter for one request's payload strategies. */
export interface AttemptRef {
  value: number
}

export interface AdaptPayloadStrategyDeps<TPayload> {
  /** Shared 0-based attempt counter, incremented after each handle. */
  attemptRef: AttemptRef
  /** Stable retry baseline (`RetryContext.originalPayload`) — never mutated across retries. */
  originalPayload: TPayload
  /** Resolved model available to format-native strategy decisions. */
  model: Model | undefined
  /** Normal-retry budget (`RetryContext.maxRetries`) used by strategy decisions and logs. */
  maxRetries: number
}

/**
 * Wrap one payload `RetryStrategy<TPayload>` as an env-based {@link EnvRetryStrategy}.
 * Construct the payload strategy fresh per request (its per-instance once-state —
 * `hasRetried` / `hasRefreshed` — then tracks that request's retries).
 */
export function adaptPayloadStrategy<TPayload>(payload: PayloadRetryStrategy<TPayload>, deps: AdaptPayloadStrategyDeps<TPayload>): EnvRetryStrategy {
  return {
    name: payload.name,

    canHandle(error: ApiError): boolean {
      return payload.canHandle(error)
    },

    async handle(error: ApiError, env: RequestEnvelope): Promise<EnvRetryAction> {
      const context: RetryContext<TPayload> = {
        attempt: deps.attemptRef.value,
        originalPayload: deps.originalPayload,
        model: deps.model,
        maxRetries: deps.maxRetries,
      }
      const action = await payload.handle(error, env.body as TPayload, context)
      deps.attemptRef.value++

      if (action.action === "abort") return { kind: "abort", error: action.error }

      const patch: Parameters<RequestEnvelope["with"]>[0] = { body: action.payload }
      if (action.prepareHints) patch.prepareHints = action.prepareHints

      // Attach payload `action.meta` to the env-action rather than firing onMeta
      // immediately (C0-② / RFC §11.2): the driver captures it AFTER the budget
      // gate accepts the retry, so a budget-rejected retry's meta never produces
      // phantom pipeline-info / onResolved learning.
      return {
        kind: "retry",
        env: env.with(patch),
        ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
        ...(action.learning && { learning: action.learning }),
        ...(action.meta && { meta: action.meta }),
      }
    },

    ...(payload.onResolved && {
      onResolved: (env: RequestEnvelope, meta?: Record<string, unknown>): void | Promise<void> =>
        payload.onResolved?.({ payload: env.body as TPayload, prepareHints: env.prepareHints, meta, attempt: deps.attemptRef.value }),
    }),
  }
}
