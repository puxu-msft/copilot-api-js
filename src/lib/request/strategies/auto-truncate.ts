/**
 * Auto-truncate retry strategy.
 *
 * Handles token limit errors by truncating the message payload and retrying.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"
import type { Model } from "~/lib/models/client"

import { AUTO_TRUNCATE_RETRY_FACTOR, tryParseAndLearnLimit } from "~/lib/auto-truncate"
import { HTTPError } from "~/lib/error"

import type { RetryAction, RetryContext, RetryStrategy, SanitizeResult } from "../pipeline"

/** Result from a truncation operation */
export interface TruncateResult<TPayload> {
  wasTruncated: boolean
  payload: TPayload
  removedMessageCount: number
  originalTokens: number
  compactedTokens: number
  processingTimeMs: number
}

/** Options passed to the truncation function */
export interface TruncateOptions {
  checkTokenLimit: boolean
  targetTokenLimit?: number
}

/**
 * Create an auto-truncate retry strategy.
 *
 * @param truncate - Format-specific truncation function
 * @param resanitize - Format-specific re-sanitization after truncation
 * @param isEnabled - Check if auto-truncate is enabled (typically reads state.autoTruncate)
 */
export function createAutoTruncateStrategy<TPayload>(opts: {
  truncate: (payload: TPayload, model: Model, options: TruncateOptions) => Promise<TruncateResult<TPayload>>
  resanitize: (payload: TPayload) => SanitizeResult<TPayload>
  isEnabled: () => boolean
  label: string
}): RetryStrategy<TPayload> {
  const { truncate, resanitize, isEnabled, label } = opts

  return {
    name: "auto-truncate",

    canHandle(error: ApiError): boolean {
      if (!isEnabled()) return false
      return error.type === "payload_too_large" || error.type === "token_limit"
    },

    async handle(
      error: ApiError,
      currentPayload: TPayload,
      context: RetryContext<TPayload>,
    ): Promise<RetryAction<TPayload>> {
      const { attempt, originalPayload, model, maxRetries } = context

      if (!model) {
        return { action: "abort", error }
      }

      // Extract the raw error to get HTTP details for tryParseAndLearnLimit
      const rawError = error.raw
      if (!(rawError instanceof HTTPError)) {
        return { action: "abort", error }
      }

      // Estimate tokens using GPT tokenizer for calibration feedback
      const payloadJson = JSON.stringify(currentPayload)
      const estimatedTokens = Math.ceil(payloadJson.length / 4)

      const parsed = tryParseAndLearnLimit(rawError, model.id, true, estimatedTokens)

      if (!parsed) {
        // For 413 errors without parseable limit info, still retry with truncation
        if (rawError.status === 413) {
          consola.info(
            `[${label}] Attempt ${attempt + 1}/${maxRetries + 1}: ` + `413 Body too large, retrying with truncation...`,
          )

          const truncateResult = await truncate(originalPayload, model, {
            checkTokenLimit: true,
          })

          if (!truncateResult.wasTruncated) {
            return { action: "abort", error }
          }

          const sanitizeResult = resanitize(truncateResult.payload)
          return {
            action: "retry",
            payload: sanitizeResult.payload,
            meta: {
              truncateResult,
              sanitization: sanitizeResult.stats ?? {
                totalBlocksRemoved: sanitizeResult.removedCount,
                systemReminderRemovals: sanitizeResult.systemReminderRemovals,
              },
              attempt: attempt + 1,
            },
          }
        }

        return { action: "abort", error }
      }

      // Calculate target token limit based on error info
      let targetTokenLimit: number | undefined

      if (parsed.limit) {
        targetTokenLimit = Math.floor(parsed.limit * AUTO_TRUNCATE_RETRY_FACTOR)
        consola.info(
          `[${label}] Attempt ${attempt + 1}/${maxRetries + 1}: `
            + `Token limit error (${parsed.current}>${parsed.limit}), `
            + `retrying with limit ${targetTokenLimit}...`,
        )
      }

      // Truncate from original payload (not from already-truncated)
      const truncateResult = await truncate(originalPayload, model, {
        checkTokenLimit: true,
        targetTokenLimit,
      })

      if (!truncateResult.wasTruncated) {
        // Truncation didn't help
        return { action: "abort", error }
      }

      // Re-sanitize the truncated payload
      const sanitizeResult = resanitize(truncateResult.payload)

      return {
        action: "retry",
        payload: sanitizeResult.payload,
        meta: {
          truncateResult,
          sanitization: sanitizeResult.stats ?? {
            totalBlocksRemoved: sanitizeResult.removedCount,
            systemReminderRemovals: sanitizeResult.systemReminderRemovals,
          },
          attempt: attempt + 1,
        },
      }
    },
  }
}
