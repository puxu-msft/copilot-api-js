/**
 * Request execution pipeline with pluggable retry strategies.
 *
 * Unifies the retry loop pattern shared by all API handlers:
 * messages, chat-completions, and responses.
 */

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { ApiError } from "~/lib/error"
import type { EndpointType, SanitizationInfo } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"

import { classifyError } from "~/lib/error"

// --- FormatAdapter ---

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
  /** Execute API call — raw execution without rate limiting wrapper */
  execute(payload: TPayload): Promise<{ result: unknown; queueWaitMs: number }>
  logPayloadSize(payload: TPayload): void | Promise<void>
}

// --- RetryStrategy ---

export interface RetryContext<TPayload> {
  attempt: number
  originalPayload: TPayload
  model: Model | undefined
  maxRetries: number
}

export type RetryAction<TPayload> =
  | { action: "retry"; payload: TPayload; waitMs?: number; meta?: Record<string, unknown> }
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
      const { result: response, queueWaitMs } = await adapter.execute(effectivePayload)
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

    throw lastError instanceof Error ? lastError : new Error("Unknown error")
  }

  // Should not reach here
  throw new Error("Unexpected state in pipeline retry loop")
}
