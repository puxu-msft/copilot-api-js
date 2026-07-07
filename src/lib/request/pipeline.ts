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
  /**
   * Native server tool type prefixes (e.g. `web_search_`) to strip from the
   * next wire payload, in addition to anything the global config / negotiation
   * cache already strips. Set by the server-tool-rejection retry strategy.
   */
  excludeServerToolTypes?: ReadonlyArray<string>
  /**
   * Custom-tool top-level field names (e.g. `eager_input_streaming`) to strip
   * from every tool in the next wire payload, in addition to anything the
   * built-in defaults / global config / negotiation cache already strips. Set by
   * the tool-field-rejection retry strategy when the upstream rejects an unknown
   * tool field with `tools.N.<variant>.<field>: Extra inputs are not permitted`.
   */
  excludeToolFields?: ReadonlyArray<string>
  /**
   * L2 buffered-retry escalation (RFC §8): FORCE an aggressive native `clear_tool_uses`
   * context_management edit on this attempt's wire (independent of `context_editing` mode) to
   * compress the context so the generation finishes faster. Set by the buffered driver's
   * `escalate` hook per retry, with progressively tighter values. Skipped when the model doesn't
   * support context_management (gated by `contextManagementDisabled`).
   */
  contextEscalation?: { trigger: number; keepTools: number; keepThinking: number }
}

export type RetryAction<TPayload> =
  | {
      action: "retry"
      payload: TPayload
      waitMs?: number
      meta?: Record<string, unknown>
      /** Format-specific preparation hints forwarded to the next adapter.execute() call. */
      prepareHints?: PrepareHints
      /**
       * Mark this as a **learning-type** retry — a deterministically converging
       * probe (e.g. beta combination enumeration) that locates an upstream
       * incompatibility. Learning retries draw from a separate budget and do
       * NOT consume the main `maxRetries` allowance, so a strategy can iterate
       * far enough to pinpoint the offending element without starving ordinary
       * retries. Capped independently (`MAX_LEARNING_RETRIES`) to bound latency
       * and prevent combinatorial runaway.
       */
      learning?: boolean
    }
  | { action: "abort"; error: ApiError }

/**
 * Context passed to a strategy's `onResolved` hook when one of its retry
 * actions ultimately produced a successful response. Lets a strategy commit
 * what it learned (e.g. persist the located offending betas to the negotiation
 * cache) — keeping "who modified, who learns" cohesive inside the strategy
 * instead of leaking demux logic into every handler.
 */
export interface ResolvedContext<TPayload> {
  /** The effective payload that ultimately succeeded. */
  payload: TPayload
  /** Preparation hints carried by the successful attempt. */
  prepareHints?: PrepareHints
  /** Meta from the retry action that produced the successful attempt. */
  meta?: Record<string, unknown>
  /** 0-based execution index that succeeded (equals total retries). */
  attempt: number
}

export interface RetryStrategy<TPayload> {
  readonly name: string
  /** Check if this strategy can handle the given error */
  canHandle(error: ApiError): boolean
  /** Handle the error and decide whether to retry or abort */
  handle(error: ApiError, payload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>>
  /**
   * Called when a retry action produced by THIS strategy ultimately led to a
   * successful response. Optional. Receives the successful payload, the hints
   * and meta carried by that final attempt. Use it to commit learning (e.g.
   * fixate the located offending betas into the negotiation cache).
   */
  onResolved?(context: ResolvedContext<TPayload>): void | Promise<void>
}

// --- Pipeline ---

/**
 * Hard cap on learning-type retries within a single pipeline run. Bounds
 * latency and prevents combinatorial runaway when a learning strategy enumerates
 * candidate combinations (e.g. beta subset enumeration is 2ⁿ−1 in the worst
 * case). 32 covers full enumeration of up to 5 candidates and a generous prefix
 * beyond that; learning strategies are expected to abort earlier on their own.
 */
const MAX_LEARNING_RETRIES = 32

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
  // The loop only exits via `break` (always inside catch, after lastError is
  // set) or `return`, so lastError is definitely assigned before any read.
  let lastError: unknown
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

  // Strategy whose most recent retry produced the current effectivePayload —
  // notified via onResolved when a later attempt succeeds, so it can commit
  // what it learned (e.g. fixate located betas). Paired meta travels alongside.
  let lastRetryStrategy: RetryStrategy<TPayload> | undefined
  let lastRetryMeta: Record<string, unknown> | undefined

  // Two independent retry budgets. Ordinary retries consume `maxRetries`;
  // learning retries (deterministic probes, e.g. beta combination enumeration)
  // consume a separate `MAX_LEARNING_RETRIES` allowance so they cannot starve
  // ordinary retries and vice-versa. `execIndex` is the running execution
  // counter used for attempt numbering / totalRetries, independent of which
  // budget each retry drew from.
  let execIndex = 0
  let normalRetries = 0
  let learningRetries = 0

  for (;;) {
    // 1. Create attempt first (ensures currentAttempt is available for subsequent calls)
    requestContext?.beginAttempt({
      strategy: execIndex > 0 ? lastStrategyName : undefined,
    })

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
    onBeforeAttempt?.(execIndex, effectivePayload)
    requestContext?.transition("executing")

    try {
      const { result: response, queueWaitMs } = await adapter.execute(effectivePayload, pendingPrepareHints)
      totalQueueWaitMs += queueWaitMs
      requestContext?.addQueueWaitMs(queueWaitMs)

      // Notify the strategy that owns the final modification so it can commit
      // its learning. Only fires when a retry actually produced this payload —
      // `lastRetryStrategy` stays undefined on a first-attempt success.
      if (lastRetryStrategy) {
        await lastRetryStrategy.onResolved?.({
          payload: effectivePayload,
          prepareHints: pendingPrepareHints,
          meta: lastRetryMeta,
          attempt: execIndex,
        })
      }

      return {
        response,
        effectivePayload,
        queueWaitMs: totalQueueWaitMs,
        totalRetries: execIndex,
      }
    } catch (error) {
      lastError = error

      // Classify and record the error on the current attempt (always, including final attempt)
      const apiError = classifyError(error)
      requestContext?.setAttemptError(apiError)

      // Find first strategy that can handle this error → decide retry/abort
      let chosen: {
        strategy: RetryStrategy<TPayload>
        action: Extract<RetryAction<TPayload>, { action: "retry" }>
      } | null = null
      for (const strategy of strategies) {
        if (!strategy.canHandle(apiError)) continue

        const retryContext: RetryContext<TPayload> = {
          attempt: execIndex,
          originalPayload,
          model,
          maxRetries,
        }

        try {
          const action = await strategy.handle(apiError, effectivePayload, retryContext)
          if (action.action === "retry") chosen = { strategy, action }
          // retry chosen, or abort → stop scanning strategies
          break
        } catch (strategyError) {
          consola.warn(
            `[Pipeline] Strategy "${strategy.name}" failed on attempt ${execIndex + 1}:`,
            strategyError instanceof Error ? strategyError.message : strategyError,
          )
          // Strategy itself failed, break out to throw original error
          break
        }
      }

      if (!chosen) break

      const { strategy, action } = chosen

      // Budget gate: learning retries draw from a separate allowance so a
      // deterministic probe can iterate far enough to pinpoint the offending
      // element without starving ordinary retries — and is itself hard-capped
      // to bound latency / prevent combinatorial runaway.
      //
      // NOTE: the gate runs AFTER `handle()`, because whether a retry is
      // learning-type is only known from the action. So on the attempt that
      // exhausts a budget, the chosen strategy's `handle()` has already run its
      // side effects before the retry is discarded here. Strategy `handle()`
      // side effects must therefore be idempotent / self-guarding (e.g.
      // token-refresh sets `hasRefreshed` and its `canHandle` returns false
      // afterwards, bounding it to a single refresh).
      if (action.learning === true) {
        if (learningRetries >= MAX_LEARNING_RETRIES) break
        learningRetries++
      } else {
        if (normalRetries >= maxRetries) break
        normalRetries++
      }

      // Surface the failed attempt in the TUI as a [RETRY-n] line. Runs AFTER
      // the budget gate so retries about to be discarded don't produce noise.
      // Web-search internal hops naturally skip — they pass `requestContext: undefined`.
      // Note: setAttemptError was already called above with apiError, so the
      // current attempt's error/strategy/wireRequest are populated by the
      // time recordAttemptFailure snapshots them.
      requestContext?.recordAttemptFailure({
        willRetry: true,
        nextStrategy: strategy.name,
        waitMs: action.waitMs,
        learning: action.learning === true,
      })

      consola.debug(`[Pipeline] Strategy "${strategy.name}" requests ${action.learning ? "learning " : ""}retry (exec ${execIndex + 1})`)

      if (action.waitMs && action.waitMs > 0) {
        totalQueueWaitMs += action.waitMs
        requestContext?.addQueueWaitMs(action.waitMs)
      }

      // Auto-record sanitization from strategy meta (e.g. auto-truncate provides this)
      if (action.meta?.sanitization && requestContext) {
        requestContext.setAttemptSanitization(action.meta.sanitization as SanitizationInfo)
      }

      lastStrategyName = strategy.name
      lastRetryStrategy = strategy
      lastRetryMeta = action.meta
      effectivePayload = action.payload
      pendingPrepareHints = action.prepareHints
      onRetry?.(execIndex, strategy.name, action.payload, action.meta)
      execIndex++
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
