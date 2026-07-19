/**
 * Shared payload-oriented request preparation and retry contracts.
 *
 * These contracts are consumed by the format-native payload strategies and by
 * the v4 envelope adapter. They intentionally do not own request execution;
 * orchestration belongs to the generation driver.
 */

import type { ApiError } from "~/lib/error"
import type { Model } from "~/lib/models/client"

export interface SanitizeResult<TPayload> {
  payload: TPayload
  /** Convenience: total blocks removed (sum of orphans + empty text). */
  blocksRemoved: number
  /** Convenience: number of system reminder tags removed. */
  systemReminderRemovals: number
  /** Format-specific structured breakdown of removals and modifications. */
  stats?: Record<string, unknown>
}

export interface RetryContext<TPayload> {
  attempt: number
  originalPayload: TPayload
  model: Model | undefined
  maxRetries: number
}

/** Per-dispatch preparation guidance produced by payload retry strategies. */
export interface PrepareHints {
  /** Beta tokens to omit from the next outbound Anthropic request. */
  excludeBetas?: ReadonlyArray<string>
  /** Body fields to omit from the next wire payload. */
  rejectFields?: ReadonlyArray<string>
  /** Native server-tool type prefixes to omit from the next wire payload. */
  excludeServerToolTypes?: ReadonlyArray<string>
  /** Custom-tool top-level field names to omit from the next wire payload. */
  excludeToolFields?: ReadonlyArray<string>
  /** Rejected cache_control subfields to omit from the next wire payload. */
  excludeCacheControlSubfields?: ReadonlyArray<string>
  /** Buffered-recovery context compression requested for this dispatch. */
  contextEscalation?: { trigger: number; keepTools: number; keepThinking: number }
}

export type RetryAction<TPayload> =
  | {
      action: "retry"
      payload: TPayload
      waitMs?: number
      meta?: Record<string, unknown>
      prepareHints?: PrepareHints
      /** Deterministic probes draw from the separate learning-retry budget. */
      learning?: boolean
    }
  | { action: "abort"; error: ApiError }

/** Resolution facts delivered to the payload strategy that produced the winning retry. */
export interface ResolvedContext<TPayload> {
  payload: TPayload
  prepareHints?: PrepareHints
  meta?: Record<string, unknown>
  /** Zero-based physical execution index that succeeded. */
  attempt: number
}

/** A format-native strategy that transforms payloads rather than envelopes. */
export interface RetryStrategy<TPayload> {
  readonly name: string
  canHandle(error: ApiError): boolean
  handle(error: ApiError, payload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>>
  onResolved?(context: ResolvedContext<TPayload>): void | Promise<void>
}
