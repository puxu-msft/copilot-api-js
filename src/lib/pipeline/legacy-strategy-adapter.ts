/**
 * v4 pipeline — legacy-strategy → env-strategy adapter.
 *
 * The driver's retry loop consumes env-based {@link EnvRetryStrategy} (handle
 * receives + returns the {@link RequestEnvelope}; retry-transport.md §2.1). The
 * existing strategies (network-retry / token-refresh / auto-truncate / …) are
 * the legacy payload-based `RetryStrategy<TPayload>` (handle receives a payload +
 * a {@link RetryContext}, returns a payload-bearing action). This adapter bridges
 * the two **without rewriting** the strategy logic, so behavior stays byte-identical
 * to the legacy `executeRequestPipeline` path.
 *
 * Mapping:
 *   - `handle(error, env)` synthesizes a `RetryContext` from per-request closure
 *     state (the stable `originalPayload` baseline, `model`, `maxRetries`) + a
 *     shared `attempt` counter, runs the legacy `handle(error, env.body, ctx)`,
 *     then folds the legacy action back: `retry.payload`/`prepareHints` → `env.with(...)`,
 *     `abort` → `{ kind: "abort" }`.
 *   - `action.meta` (e.g. auto-truncate's `truncateResult`) is surfaced via
 *     `onMeta` so the route can carry it to the response side (truncation marker).
 *
 * The `attempt` counter is **shared** across all adapted strategies of one request
 * (a `{ value }` ref the factory increments per handle), approximating the legacy
 * global 0-based execution index used in the strategies' log lines.
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
  RetryStrategy as LegacyRetryStrategy,
} from "~/lib/request/pipeline"

/** Mutable shared attempt counter (the legacy global execution index). */
export interface AttemptRef {
  value: number
}

export interface AdaptLegacyStrategyDeps<TPayload> {
  /** Shared 0-based attempt counter, incremented after each handle. */
  attemptRef: AttemptRef
  /** Stable truncation baseline (legacy `RetryContext.originalPayload`) — never mutated across retries. */
  originalPayload: TPayload
  /** Resolved model (auto-truncate needs it; network/token-refresh ignore it). */
  model: Model | undefined
  /** Normal-retry budget (legacy `RetryContext.maxRetries`) — used in log lines only. */
  maxRetries: number
  /** Surface a retry action's `meta` (e.g. `{ truncateResult }`) to the caller. */
  onMeta?: (meta: Record<string, unknown>) => void
}

/**
 * Wrap one legacy `RetryStrategy<TPayload>` as an env-based {@link EnvRetryStrategy}.
 * Construct the legacy strategy fresh per request (its per-instance once-state —
 * `hasRetried` / `hasRefreshed` — then tracks that request's retries).
 */
export function adaptLegacyStrategy<TPayload>(legacy: LegacyRetryStrategy<TPayload>, deps: AdaptLegacyStrategyDeps<TPayload>): EnvRetryStrategy {
  return {
    name: legacy.name,

    canHandle(error: ApiError): boolean {
      return legacy.canHandle(error)
    },

    async handle(error: ApiError, env: RequestEnvelope): Promise<EnvRetryAction> {
      const context: RetryContext<TPayload> = {
        attempt: deps.attemptRef.value,
        originalPayload: deps.originalPayload,
        model: deps.model,
        maxRetries: deps.maxRetries,
      }
      const action = await legacy.handle(error, env.body as TPayload, context)
      deps.attemptRef.value++

      if (action.action === "abort") return { kind: "abort", error: action.error }

      if (action.meta) deps.onMeta?.(action.meta)

      const patch: Parameters<RequestEnvelope["with"]>[0] = { body: action.payload }
      if (action.prepareHints) patch.prepareHints = action.prepareHints

      return {
        kind: "retry",
        env: env.with(patch),
        ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
        ...(action.learning && { learning: action.learning }),
      }
    },

    ...(legacy.onResolved && {
      onResolved: (env: RequestEnvelope): void | Promise<void> =>
        legacy.onResolved?.({ payload: env.body as TPayload, prepareHints: env.prepareHints, attempt: deps.attemptRef.value }),
    }),
  }
}
