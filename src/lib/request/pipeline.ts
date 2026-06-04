/**
 * Request execution pipeline with pluggable retry strategies.
 *
 * Unifies the retry loop pattern shared by all API handlers:
 * messages, chat-completions, and responses.
 */

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { ApiError } from "~/lib/error"
import type {
  //
  EndpointType,
  SanitizationInfo,
} from "~/lib/history/store"
import type { Model } from "~/lib/models/client"

import { classifyError } from "~/lib/error"

// --- FormatAdapter ---

/**
 * Stringify an unknown throw value preserving as much diagnostic detail as
 * possible. Plain objects use JSON; primitives use String(); everything that
 * fails JSON.stringify (circular refs etc.) falls back to a generic marker.
 */
function safeStringifyUnknown(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable error value]"
  }
}

export interface SanitizeResult<TPayload> {
  payload: TPayload
  /** Convenience: total blocks removed (sum of orphans + empty text) */
  blocksRemoved: number
  /** Convenience: number of system reminder tags removed */
  systemReminderRemovals: number
  /** Structured breakdown of what was removed/modified — format-specific detail */
  stats?: Record<string, number>
}

export interface FormatAdapter<TPayload> {
  readonly format: EndpointType
  sanitize(payload: TPayload): SanitizeResult<TPayload>
  /**
   * Execute the API call — raw execution without rate limiting wrapper.
   *
   * `hints` is an opaque (typed as `PrepareHints` in pipeline.ts) bag of
   * preparation guidance the adapter SHOULD forward to its format-specific
   * preparation step. The pipeline supplies hints from the most recent
   * retry action; on the first attempt and on attempts that did not produce
   * hints, this argument is undefined. Adapters that don't recognize a hint
   * field MUST ignore it (forward-compatible).
   */
  execute(payload: TPayload, hints?: PrepareHints): Promise<{ result: unknown; queueWaitMs: number }>
  logPayloadSize(payload: TPayload): void | Promise<void>
}

// --- RetryStrategy ---

export interface RetryContext<TPayload> {
  attempt: number
  originalPayload: TPayload
  model: Model | undefined
  maxRetries: number
}

/**
 * Optional preparation hints attached to a retry action. The pipeline passes
 * these to the adapter on the next attempt; the adapter forwards them to
 * format-specific request preparation (e.g. `prepareAnthropicRequest`).
 *
 * Why this exists: previously, strategies like `unsupported-beta-retry`
 * communicated "exclude these betas on the next prep" implicitly via a
 * global negotiation cache. That coupled retry success to an undocumented
 * adapter contract ("execute() must re-prepare and re-read cache every
 * attempt"). Hints make the dependency explicit, statically typed, and
 * testable — the cache continues to exist as a cross-request memo, but
 * it is no longer the only carrier of intra-retry intent.
 *
 * Adapters that don't recognize a hint field MUST ignore it (forward-compat).
 */
export interface PrepareHints {
  /**
   * Beta tokens to drop from the outbound `anthropic-beta` header on the
   * next prep, in addition to anything the global cache already strips.
   */
  excludeBetas?: ReadonlyArray<string>
  /**
   * Body fields to drop from the next wire payload, in addition to anything
   * the global cache already strips.
   */
  rejectFields?: ReadonlyArray<string>
}

export type RetryAction<TPayload> =
  | {
      action: "retry"
      payload: TPayload
      waitMs?: number
      meta?: Record<string, unknown>
      /** Format-specific preparation hints forwarded to the next adapter.execute() call. */
      prepareHints?: PrepareHints
    }
  | { action: "abort"; error: ApiError }

export interface RetryStrategy<TPayload> {
  readonly name: string
  /** Check if this strategy can handle the given error */
  canHandle(error: ApiError): boolean
  /** Handle the error and decide whether to retry or abort */
  handle(error: ApiError, payload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>>
}

// --- Pipeline ---

export interface PipelineResult {
  response: unknown
  effectivePayload: unknown
  queueWaitMs: number
  totalRetries: number
}

export interface PipelineOptions<TPayload> {
  adapter: FormatAdapter<TPayload>
  strategies: Array<RetryStrategy<TPayload>>
  payload: TPayload
  originalPayload: TPayload
  model: Model | undefined
  maxRetries?: number
  /** Optional request context for lifecycle tracking */
  requestContext?: RequestContext
  /** Called before each attempt (for tracking tags, etc.) */
  onBeforeAttempt?: (attempt: number, payload: TPayload) => void
  /** Called after successful truncation retry (for recording rewrites, etc.) */
  onRetry?: (attempt: number, strategyName: string, newPayload: TPayload, meta?: Record<string, unknown>) => void
}

/**
 * Execute a request through the pipeline with retry strategies.
 *
 * Flow:
 * 1. Execute API call with the current payload
 * 2. On success → return response
 * 3. On failure → classify error → find first matching strategy → handle
 *    - retry → use new payload, loop back to step 1
 *    - abort or no strategy → throw error
 */
export async function executeRequestPipeline<TPayload>(opts: PipelineOptions<TPayload>): Promise<PipelineResult> {
  const { adapter, strategies, originalPayload, model, maxRetries = 3, requestContext, onBeforeAttempt, onRetry } = opts

  let effectivePayload = opts.payload
  let lastError: unknown = null
  let totalQueueWaitMs = 0
  let lastStrategyName: string | undefined
  // Preparation hints from the most recent retry action. Cleared on attempt 0.
  // **Replace semantics** (not merge): each retry's `prepareHints` completely
  // overrides the previous one. A strategy that returns `prepareHints: undefined`
  // clears prior hints. Rationale: hints are intra-retry intent ("this attempt
  // should exclude X"); cross-request memory belongs in negotiation cache.
  // Merging would silently accumulate exclusions across unrelated strategies
  // — exactly the implicit-state coupling H4 was designed to eliminate.
  let pendingPrepareHints: PrepareHints | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 1. Create attempt first (ensures currentAttempt is available for subsequent calls)
    requestContext?.beginAttempt({
      strategy: attempt > 0 ? lastStrategyName : undefined,
    })
    lastStrategyName = undefined

    // 2. Auto-record effective payload on each attempt (covers all handlers)
    if (requestContext) {
      const p = effectivePayload as Record<string, unknown>
      requestContext.setAttemptEffectiveRequest({
        model: typeof p.model === "string" ? p.model : "",
        resolvedModel: model,
        messages: Array.isArray(p.messages) ? p.messages : [],
        payload: effectivePayload,
        format: adapter.format,
      })
    }

    // 3. External callback (currentAttempt now exists)
    onBeforeAttempt?.(attempt, effectivePayload)
    requestContext?.transition("executing")

    try {
      const { result: response, queueWaitMs } = await adapter.execute(effectivePayload, pendingPrepareHints)
      totalQueueWaitMs += queueWaitMs
      requestContext?.addQueueWaitMs(queueWaitMs)

      return {
        response,
        effectivePayload,
        queueWaitMs: totalQueueWaitMs,
        totalRetries: attempt,
      }
    } catch (error) {
      lastError = error

      // Classify and record the error on the current attempt (always, including final attempt)
      const apiError = classifyError(error)
      requestContext?.setAttemptError(apiError)

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) break

      // Find first strategy that can handle this error
      let handled = false
      for (const strategy of strategies) {
        if (!strategy.canHandle(apiError)) continue

        const retryContext: RetryContext<TPayload> = {
          attempt,
          originalPayload,
          model,
          maxRetries,
        }

        try {
          const action = await strategy.handle(apiError, effectivePayload, retryContext)

          if (action.action === "retry") {
            consola.debug(
              `[Pipeline] Strategy "${strategy.name}" requests retry ` + `(attempt ${attempt + 1}/${maxRetries + 1})`,
            )

            if (action.waitMs && action.waitMs > 0) {
              totalQueueWaitMs += action.waitMs
              requestContext?.addQueueWaitMs(action.waitMs)
            }

            // Auto-record sanitization from strategy meta (e.g. auto-truncate provides this)
            if (action.meta?.sanitization && requestContext) {
              requestContext.setAttemptSanitization(action.meta.sanitization as SanitizationInfo)
            }

            lastStrategyName = strategy.name
            effectivePayload = action.payload
            pendingPrepareHints = action.prepareHints
            onRetry?.(attempt, strategy.name, action.payload, action.meta)
            handled = true
            break
          }

          // action === "abort": fall through to break
          break
        } catch (strategyError) {
          consola.warn(
            `[Pipeline] Strategy "${strategy.name}" failed on attempt ${attempt + 1}:`,
            strategyError instanceof Error ? strategyError.message : strategyError,
          )
          // Strategy itself failed, break out to throw original error
          break
        }
      }

      if (!handled) break
    }
  }

  // If we exit the loop, it means all retries failed or no strategy handled the error
  if (lastError) {
    // Log payload size info for 413 errors
    const apiError = classifyError(lastError)
    if (apiError.type === "payload_too_large") {
      await adapter.logPayloadSize(effectivePayload)
    }

    // Preserve non-Error throws (string, number, plain object …) — the
    // original value is often diagnostic (e.g. an HTTPError-shaped object
    // thrown raw, or a TimeoutError from a third-party library). JSON
    // stringify covers plain objects (which `String(x)` would render as
    // `"[object Object]"`, losing the diagnostic) and falls back to the
    // String form when JSON.stringify can't handle the value.
    if (lastError instanceof Error) throw lastError
    throw new Error(safeStringifyUnknown(lastError))
  }

  // Should not reach here
  throw new Error("Unexpected state in pipeline retry loop")
}
