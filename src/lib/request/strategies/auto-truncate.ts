/**
 * Auto-truncate retry strategy.
 *
 * Handles token limit errors by truncating the message payload and retrying.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"
import type { Model } from "~/lib/models/client"

import {
  //
  tryParseAndLearnLimit,
} from "~/lib/auto-truncate"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
  SanitizeResult,
} from "../pipeline"

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
  /**
   * Count the payload's tokens with the SAME tokenizer the format-specific
   * `truncate` uses internally (gpt-tokenizer). Injected per-format because the
   * counter is format-specific, while the unit-conversion math below is shared.
   * This is what lets the strategy convert the upstream-reported limit (Anthropic
   * token caliber) into the gpt caliber that `truncate` actually compares against.
   */
  countTokens: (payload: TPayload, model: Model) => Promise<number>
  isEnabled: () => boolean
  label: string
}): RetryStrategy<TPayload> {
  const { truncate, resanitize, countTokens, isEnabled, label } = opts

  return {
    name: "auto-truncate",

    canHandle(error: ApiError): boolean {
      if (!isEnabled()) return false
      return error.type === "payload_too_large" || error.type === "token_limit"
    },

    async handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const { attempt, originalPayload, model, maxRetries } = context

      if (!model) {
        return { action: "abort", error }
      }

      // Extract the raw error to get HTTP details for tryParseAndLearnLimit
      const rawError = error.raw
      if (!(rawError instanceof HTTPError)) {
        return { action: "abort", error }
      }

      // Count the failing payload with the same gpt-tokenizer `truncate` uses
      // internally — NOT char/4. Three calibers are in play: the upstream-reported
      // current/limit (Anthropic token caliber), this gpt-tokenizer count, and the
      // old char/4 estimate. Feeding gpt count here makes calibration learn
      // `factor = reportedCurrent / gptCount` — exactly the factor `calibrate()`
      // multiplies a gpt estimate by in the pre-check paths, so both paths agree.
      const gptCount = await countTokens(currentPayload, model)

      const parsed = tryParseAndLearnLimit(rawError, model.id, true, gptCount)

      // Helper closure: run truncation + re-sanitize and assemble a RetryAction.
      // Used by both branches below (parsed token limit + 413 fallback).
      const truncateAndBuildRetry = async (targetTokenLimit: number | undefined): Promise<RetryAction<TPayload>> => {
        // Truncate from original payload (not from already-truncated)
        const truncateResult = await truncate(originalPayload, model, {
          checkTokenLimit: true,
          ...(targetTokenLimit !== undefined && { targetTokenLimit }),
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
              totalBlocksRemoved: sanitizeResult.blocksRemoved,
              systemReminderRemovals: sanitizeResult.systemReminderRemovals,
            },
            attempt: attempt + 1,
          },
        }
      }

      if (!parsed) {
        // For 413 errors without parseable limit info, still retry with truncation
        if (rawError.status === 413) {
          consola.info(`[${label}] Attempt ${attempt + 1}/${maxRetries + 1}: ` + `413 Body too large, retrying with truncation...`)
          return truncateAndBuildRetry(undefined)
        }

        return { action: "abort", error }
      }

      // Calculate target token limit based on error info
      let targetTokenLimit: number | undefined

      if (parsed.limit) {
        // Convert the reported target into the gpt caliber that `truncate`
        // compares against. `ratio = reportedCurrent / gptCount` is this request's
        // measured Anthropic→gpt token ratio (~2x for Claude models); dividing the
        // reported target by it yields the equivalent gpt-caliber target:
        //   targetGpt = limit × FACTOR × gptCount / reportedCurrent
        // Without this conversion the reported target (Anthropic caliber, ~900k)
        // sits far above truncate's internal gpt count (~480k), so truncate decides
        // "no truncation needed" and the request fails again. The ratio is measured
        // on currentPayload but applied to originalPayload inside truncate; both are
        // the same conversation so their tokenizer ratios match closely, and the
        // FACTOR margin absorbs the residual. When reportedCurrent is missing
        // we fall back to the raw reported target (pre-fix behavior).
        const reportedTarget = parsed.limit * state.autoTruncateTargetFactor
        const ratio = parsed.current && parsed.current > 0 && gptCount > 0 ? parsed.current / gptCount : undefined
        targetTokenLimit = ratio !== undefined ? Math.floor(reportedTarget / ratio) : Math.floor(reportedTarget)
        consola.info(
          `[${label}] Attempt ${attempt + 1}/${maxRetries + 1}: `
            + `Token limit error (${parsed.current}>${parsed.limit}), gptCount=${gptCount}`
            + `${ratio !== undefined ? `, ratio=${ratio.toFixed(3)}` : ""}, `
            + `retrying with gpt-caliber limit ${targetTokenLimit}...`,
        )
      }

      return truncateAndBuildRetry(targetTokenLimit)
    },
  }
}
