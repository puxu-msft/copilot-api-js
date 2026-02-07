/**
 * Request execution pipeline with pluggable retry strategies.
 *
 * Unifies the retry loop pattern shared by direct-anthropic-handler,
 * translated-handler, and (soon) completions handler.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"
import type { Model } from "~/services/copilot/get-models"

import { classifyError } from "~/lib/error"

// --- FormatAdapter ---

export interface SanitizeResult<TPayload> {
  payload: TPayload
  removedCount: number
  systemReminderRemovals: number
}

export interface FormatAdapter<TPayload> {
  readonly format: string
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
  const { adapter, strategies, originalPayload, model, maxRetries = 3, onBeforeAttempt, onRetry } = opts

  let effectivePayload = opts.payload
  let lastError: unknown = null
  let totalQueueWaitMs = 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onBeforeAttempt?.(attempt, effectivePayload)

    try {
      const { result: response, queueWaitMs } = await adapter.execute(effectivePayload)
      totalQueueWaitMs += queueWaitMs

      return {
        response,
        effectivePayload,
        queueWaitMs: totalQueueWaitMs,
        totalRetries: attempt,
      }
    } catch (error) {
      lastError = error

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) break

      // Classify the error
      const apiError = classifyError(error)

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
            }

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
