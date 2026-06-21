/**
 * Shared Anthropic retry-pipeline assembly.
 *
 * Extracted from the /v1/messages handler so BOTH the direct completion path
 * and the web_search double-hop orchestrator can run upstream calls through the
 * same `executeRequestPipeline` — getting auto-truncate, network-retry,
 * token-refresh, beta negotiation, and adaptive rate-limiting uniformly.
 *
 * The sanitize/resanitize steps are injected as closures rather than hardcoded:
 * the direct path uses the full `preprocessTools` + tool-name pipeline, while
 * the web_search hops use a plain `sanitizeAnthropicMessages` (they deliberately
 * downgrade native server tools to function tools via `toFirstHopTools` and must
 * NOT have `preprocessTools` re-inject tool_search / stubs).
 */

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  FormatAdapter,
  PipelineResult,
  SanitizeResult,
} from "~/lib/request/pipeline"
import type { MessagesPayload } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import {
  //
  autoTruncateAnthropic,
  countTotalTokens,
} from "~/lib/anthropic/auto-truncate"
import {
  //
  type AnthropicMessageResponse,
  createAnthropicMessages,
} from "~/lib/anthropic/client"
import { logPayloadSizeInfoAnthropic } from "~/lib/request/payload"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import {
  //
  createAutoTruncateStrategy,
  type TruncateResult,
} from "~/lib/request/strategies/auto-truncate"
import { createBodyFieldRejectionStrategy } from "~/lib/request/strategies/context-management-retry"
import { createDeferredToolRetryStrategy } from "~/lib/request/strategies/deferred-tool-retry"
import { createEffortLearningRetryStrategy } from "~/lib/request/strategies/effort-learning-retry"
import { createLegacyThinkingRetryStrategy } from "~/lib/request/strategies/legacy-thinking-retry"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { createUnsupportedBetaRetryStrategy } from "~/lib/request/strategies/unsupported-beta-retry"
import { state } from "~/lib/state"

/** A sanitize step usable as both the adapter's `sanitize` and auto-truncate's `resanitize`. */
export type AnthropicSanitizeFn = (payload: MessagesPayload) => SanitizeResult<MessagesPayload>

// ============================================================================
// Beta probe
// ============================================================================

/** Split a comma-separated `anthropic-beta` header into trimmed, non-empty tokens. */
export function splitBetaHeader(value: string | undefined): Array<string> {
  if (!value) return []
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Tracks the betas actually sent upstream on the latest attempt and exposes
 * them as ordered probe candidates for the laconic `invalid beta flag` path.
 * Candidates are ordered by suspicion priority — client-supplied betas first
 * (they change most often and are the usual culprits), then locally-injected
 * ones — each group preserving outbound order.
 */
export interface BetaProbe {
  recordOutbound(headers: Record<string, string>): void
  getCandidates(): Array<string>
}

export function createBetaProbe(clientAnthropicBeta: string | undefined): BetaProbe {
  const clientSet = new Set(splitBetaHeader(clientAnthropicBeta))
  let outbound: Array<string> = []
  return {
    recordOutbound(headers) {
      outbound = splitBetaHeader(headers["anthropic-beta"])
    },
    getCandidates() {
      return outbound
        .map((beta, index) => ({ beta, index, clientRank: clientSet.has(beta) ? 0 : 1 }))
        .sort((a, b) => a.clientRank - b.clientRank || a.index - b.index)
        .map((e) => e.beta)
    },
  }
}

// ============================================================================
// Adapter + strategies
// ============================================================================

export interface BuildAnthropicAdapterArgs {
  payload: MessagesPayload
  selectedModel: Model | undefined
  headersCapture: HeadersCapture
  clientAnthropicBeta: string | undefined
  betaProbe: BetaProbe
  /** Sanitize step for the adapter (direct path = full pipeline; web_search = plain sanitize). */
  sanitize: AnthropicSanitizeFn
  /** Optional request context — `undefined` skips wire-request recording (web_search hops). */
  reqCtx?: RequestContext
  /** Aborts the upstream fetch when the client disconnects (web_search hops thread this). */
  clientAbortSignal?: AbortSignal
}

/** Build the FormatAdapter used by executeRequestPipeline for Anthropic. */
export function buildAnthropicAdapter(args: BuildAnthropicAdapterArgs): FormatAdapter<MessagesPayload> {
  const { payload: anthropicPayload, selectedModel, headersCapture, clientAnthropicBeta, betaProbe, sanitize, reqCtx, clientAbortSignal } = args
  return {
    format: "anthropic-messages",
    sanitize,
    execute: (p, hints) =>
      executeWithAdaptiveRateLimit(() =>
        createAnthropicMessages(p, {
          resolvedModel: selectedModel,
          headersCapture,
          clientAnthropicBeta,
          clientAbortSignal,
          // PrepareHints from the previous retry attempt — forwarded into
          // request preparation so the next wire payload deterministically
          // excludes the offending fields/betas, without depending on the
          // negotiation cache as the sole communication channel.
          excludeBetas: hints?.excludeBetas,
          rejectFields: hints?.rejectFields,
          onPrepared: ({ wire, headers }) => {
            // Capture the betas actually sent so the beta-retry strategy can
            // probe them if the upstream returns a laconic `invalid beta flag`.
            betaProbe.recordOutbound(headers)
            // Record `thinking` as a per-request terminal dimension: `effective`
            // = the ACTUAL outbound wire shape (post coerceAdaptiveThinking),
            // `requested` = the client's original type from the FIXED closure
            // `anthropicPayload` (NOT the per-attempt `p`, which retries mutate).
            // The console overwrites `effective` per attempt and renders
            // requested→effective once.
            const wireThinking = wire.thinking as { type?: string } | undefined
            if (wireThinking?.type && wireThinking.type !== "disabled") {
              const requestedType = (anthropicPayload.thinking as { type?: string } | undefined)?.type
              reqCtx?.recordFeature("thinking", {
                ...(requestedType !== undefined && { requested: requestedType }),
                effective: wireThinking.type,
              })
            }
            reqCtx?.setAttemptWireRequest({
              model: typeof wire.model === "string" ? wire.model : anthropicPayload.model,
              messages: Array.isArray(wire.messages) ? wire.messages : [],
              payload: wire,
              headers,
              format: "anthropic-messages",
            })
          },
        }),
      ),
    logPayloadSize: (p) => logPayloadSizeInfoAnthropic(p, selectedModel),
  }
}

/** Build the retry strategy list for Anthropic completions. */
export function buildAnthropicStrategies(args: { betaProbe: BetaProbe; resanitize: AnthropicSanitizeFn }) {
  return [
    createNetworkRetryStrategy<MessagesPayload>(),
    createTokenRefreshStrategy<MessagesPayload>(),
    // effort-learning sits between token-refresh and the other 400-class
    // strategies (lifted from the client's inner loop in P0.4). Its
    // `invalid_reasoning_effort` body match is mutually exclusive with the
    // others' 400 messages, so the relative order is safe.
    createEffortLearningRetryStrategy<MessagesPayload>(),
    createBodyFieldRejectionStrategy<MessagesPayload>(),
    createLegacyThinkingRetryStrategy<MessagesPayload>(),
    createUnsupportedBetaRetryStrategy<MessagesPayload>({
      getProbeCandidates: () => args.betaProbe.getCandidates(),
    }),
    createDeferredToolRetryStrategy<MessagesPayload>(),
    createAutoTruncateStrategy<MessagesPayload>({
      truncate: (p, model, opts) => autoTruncateAnthropic(p, model, opts) as Promise<TruncateResult<MessagesPayload>>,
      resanitize: args.resanitize,
      countTokens: (p, model) => countTotalTokens(p, model),
      isEnabled: () => state.autoTruncate,
      label: "Anthropic",
    }),
  ]
}

// ============================================================================
// Convenience wrapper
// ============================================================================

export interface RunAnthropicPipelineArgs {
  /** Sanitized payload to send (pipeline's starting payload). */
  payload: MessagesPayload
  /** Payload auto-truncate re-truncates from on each retry. */
  originalPayload: MessagesPayload
  selectedModel: Model | undefined
  clientAnthropicBeta: string | undefined
  /** Sanitize step (direct = full pipeline; web_search = plain sanitize). */
  sanitize: AnthropicSanitizeFn
  /** Re-sanitize step after truncation (usually the same as `sanitize`). */
  resanitize: AnthropicSanitizeFn
  headersCapture: HeadersCapture
  /** Request context for attempt/wire recording. `undefined` for web_search hops (no state pollution). */
  requestContext?: RequestContext
  /** Aborts the upstream fetch when the client disconnects. */
  clientAbortSignal?: AbortSignal
  maxRetries?: number
  onRetry?: (attempt: number, strategyName: string, newPayload: MessagesPayload, meta?: Record<string, unknown>) => void
}

/**
 * Assemble a beta-probe + adapter + strategies and run the request through
 * `executeRequestPipeline`. Shared by the direct handler and the web_search hops.
 */
export async function runAnthropicPipeline(args: RunAnthropicPipelineArgs): Promise<PipelineResult> {
  const betaProbe = createBetaProbe(args.clientAnthropicBeta)
  const adapter = buildAnthropicAdapter({
    payload: args.payload,
    selectedModel: args.selectedModel,
    headersCapture: args.headersCapture,
    clientAnthropicBeta: args.clientAnthropicBeta,
    betaProbe,
    sanitize: args.sanitize,
    reqCtx: args.requestContext,
    clientAbortSignal: args.clientAbortSignal,
  })
  const strategies = buildAnthropicStrategies({ betaProbe, resanitize: args.resanitize })
  return executeRequestPipeline({
    adapter,
    strategies,
    payload: args.payload,
    originalPayload: args.originalPayload,
    model: args.selectedModel,
    maxRetries: args.maxRetries ?? state.autoTruncateMaxRetries,
    requestContext: args.requestContext,
    onRetry: args.onRetry,
  })
}

/** Narrow a pipeline result's response to a non-streaming Anthropic message (web_search hops force stream:false). */
export function expectNonStreamingResponse(result: PipelineResult): AnthropicMessageResponse {
  const response = result.response
  if (response !== null && typeof response === "object" && Symbol.asyncIterator in response) {
    consola.warn("[AnthropicPipeline] Expected non-streaming response but got a stream")
  }
  return response as AnthropicMessageResponse
}
