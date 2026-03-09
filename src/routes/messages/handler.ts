/**
 * Anthropic /v1/messages route handler.
 * Parses payload, resolves model, processes system prompt,
 * and orchestrates completion (streaming / non-streaming).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type { MessageContent, ToolDefinition } from "~/lib/history"
import type { SseEventRecord } from "~/lib/history/store"
import type { MessagesPayload, StreamEvent } from "~/types/api/anthropic"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { type AnthropicAutoTruncateResult, autoTruncateAnthropic } from "~/lib/anthropic/auto-truncate"
import { createAnthropicMessages, type AnthropicMessageResponse } from "~/lib/anthropic/client"
import { processAnthropicStream, supportsDirectAnthropicApi } from "~/lib/anthropic/handlers"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { preprocessTools } from "~/lib/anthropic/message-tools"
import {
  preprocessAnthropicMessages,
  sanitizeAnthropicMessages,
  type SanitizationStats,
} from "~/lib/anthropic/sanitize"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { resolveModelName } from "~/lib/models/resolver"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import { buildAnthropicResponseData, createTruncationMarker, prependMarkerToResponse } from "~/lib/request"
import { logPayloadSizeInfoAnthropic } from "~/lib/request/payload"
import { executeRequestPipeline, type FormatAdapter } from "~/lib/request/pipeline"
import { createAutoTruncateStrategy, type TruncateResult } from "~/lib/request/strategies/auto-truncate"
import { createDeferredToolRetryStrategy } from "~/lib/request/strategies/deferred-tool-retry"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { state } from "~/lib/state"
import { StreamIdleTimeoutError } from "~/lib/stream"
import { processAnthropicSystem } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"

// ============================================================================
// Main entry point — Anthropic /v1/messages completion
// ============================================================================

/**
 * Handle an Anthropic /v1/messages request.
 * Parses payload, resolves model name, processes system prompt,
 * creates RequestContext, and routes to direct Anthropic API.
 */
export async function handleMessages(c: Context) {
  const anthropicPayload = await c.req.json<MessagesPayload>()

  // Resolve model name aliases and date-suffixed versions
  // e.g., "haiku" → "claude-haiku-4.5", "claude-sonnet-4-20250514" → "claude-sonnet-4"
  const clientModel = anthropicPayload.model
  const resolvedModel = resolveModelName(clientModel)
  if (resolvedModel !== clientModel) {
    consola.debug(`Model name resolved: ${clientModel} → ${resolvedModel}`)
    anthropicPayload.model = resolvedModel
  }
  const clientModelName = clientModel !== resolvedModel ? clientModel : undefined

  // System prompt collection + config-based overrides (always active)
  if (anthropicPayload.system) {
    anthropicPayload.system = await processAnthropicSystem(anthropicPayload.system, anthropicPayload.model)
  }

  // Get tracking ID
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Route validation BEFORE creating RequestContext — prevents dangling history entries
  // when routing fails (reqCtx.create() triggers history insertion, and a subsequent throw
  // without reqCtx.fail() would leave an entry with no response)
  const routingDecision = supportsDirectAnthropicApi(anthropicPayload.model)
  if (!routingDecision.supported) {
    const msg = `Model "${anthropicPayload.model}" does not support /v1/messages: ${routingDecision.reason}`
    throw new HTTPError(msg, 400, msg)
  }
  consola.debug(`[AnthropicRouting] ${anthropicPayload.model}: ${routingDecision.reason}`)

  // Create request context — this triggers the "created" event → history consumer inserts entry
  const manager = getRequestContextManager()
  const reqCtx = manager.create({ endpoint: "anthropic-messages", tuiLogId })
  reqCtx.setOriginalRequest({
    // Use client's original model name (before resolution/overrides)
    model: clientModelName ?? anthropicPayload.model,
    messages: anthropicPayload.messages as unknown as Array<MessageContent>,
    stream: anthropicPayload.stream ?? false,
    tools: anthropicPayload.tools as Array<ToolDefinition> | undefined,
    system: anthropicPayload.system,
    payload: anthropicPayload,
  })

  // Update TUI tracker with model info (immediate feedback, don't wait for event loop)
  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: anthropicPayload.model,
      ...(clientModelName && { clientModel: clientModelName }),
    })
  }

  // Phase 1: One-time preprocessing (idempotent, before routing)
  const preprocessed = preprocessAnthropicMessages(anthropicPayload.messages)
  anthropicPayload.messages = preprocessed.messages
  reqCtx.setPreprocessInfo({
    strippedReadTagCount: preprocessed.strippedReadTagCount,
    dedupedToolCallCount: preprocessed.dedupedToolCallCount,
  })

  return handleDirectAnthropicCompletion(c, anthropicPayload, reqCtx)
}

// ============================================================================
// Direct Anthropic completion orchestration
// ============================================================================

// Handle completion using direct Anthropic API (no translation needed)
async function handleDirectAnthropicCompletion(c: Context, anthropicPayload: MessagesPayload, reqCtx: RequestContext) {
  consola.debug("Using direct Anthropic API path for model:", anthropicPayload.model)

  // Find model for auto-truncate and usage adjustment
  const selectedModel = state.modelIndex.get(anthropicPayload.model)

  // Preprocess tools: inject stubs for history-referenced tools, set defer_loading,
  // add tool_search. Must run BEFORE sanitize — processToolBlocks (in sanitize) uses
  // the tools array to validate tool_use references in messages.
  const toolPreprocessed = preprocessTools(anthropicPayload)

  // Always sanitize messages to filter orphaned tool_result/tool_use blocks
  const { payload: initialSanitized, stats: sanitizationStats } = sanitizeAnthropicMessages(toolPreprocessed)
  reqCtx.addSanitizationInfo(toSanitizationInfo(sanitizationStats))

  // Record sanitization/preprocessing if anything was modified
  const hasPreprocessing =
    reqCtx.preprocessInfo ?
      reqCtx.preprocessInfo.dedupedToolCallCount > 0 || reqCtx.preprocessInfo.strippedReadTagCount > 0
    : false
  if (
    sanitizationStats.totalBlocksRemoved > 0
    || sanitizationStats.systemReminderRemovals > 0
    || sanitizationStats.fixedNameCount > 0
    || hasPreprocessing
  ) {
    const messageMapping = buildMessageMapping(anthropicPayload.messages, initialSanitized.messages)
    reqCtx.setRewrites({
      rewrittenMessages: initialSanitized.messages as unknown as Array<MessageContent>,
      rewrittenSystem: typeof initialSanitized.system === "string" ? initialSanitized.system : undefined,
      messageMapping,
    })
  }

  // Set initial tracking tags for log display
  if (reqCtx.tuiLogId) {
    const tags: Array<string> = []
    if (initialSanitized.thinking && initialSanitized.thinking.type !== "disabled")
      tags.push(`thinking:${initialSanitized.thinking.type}`)
    if (tags.length > 0) tuiLogger.updateRequest(reqCtx.tuiLogId, { tags })
  }

  // Build adapter and strategy for the pipeline
  const adapter: FormatAdapter<MessagesPayload> = {
    format: "anthropic-messages",
    sanitize: (p) => sanitizeAnthropicMessages(preprocessTools(p)),
    execute: (p) => executeWithAdaptiveRateLimit(() => createAnthropicMessages(p)),
    logPayloadSize: (p) => logPayloadSizeInfoAnthropic(p, selectedModel),
  }

  const strategies = [
    createNetworkRetryStrategy<MessagesPayload>(),
    createTokenRefreshStrategy<MessagesPayload>(),
    createDeferredToolRetryStrategy<MessagesPayload>(),
    createAutoTruncateStrategy<MessagesPayload>({
      truncate: (p, model, opts) => autoTruncateAnthropic(p, model, opts) as Promise<TruncateResult<MessagesPayload>>,
      resanitize: (p) => sanitizeAnthropicMessages(preprocessTools(p)),
      isEnabled: () => state.autoTruncate,
      label: "Anthropic",
    }),
  ]

  // Track truncation result for non-streaming response marker
  let truncateResult: AnthropicAutoTruncateResult | undefined

  try {
    const result = await executeRequestPipeline({
      adapter,
      strategies,
      payload: initialSanitized,
      originalPayload: anthropicPayload,
      model: selectedModel,
      maxRetries: MAX_AUTO_TRUNCATE_RETRIES,
      requestContext: reqCtx,
      onRetry: (_attempt, _strategyName, newPayload, meta) => {
        // Capture truncation result for response marker
        const retryTruncateResult = meta?.truncateResult as AnthropicAutoTruncateResult | undefined
        if (retryTruncateResult) {
          truncateResult = retryTruncateResult
        }

        // Record rewrites for the retried payload
        const retrySanitization = meta?.sanitization as SanitizationStats | undefined
        if (retrySanitization) {
          reqCtx.addSanitizationInfo(toSanitizationInfo(retrySanitization))
        }
        const retryMessageMapping = buildMessageMapping(anthropicPayload.messages, newPayload.messages)
        reqCtx.setRewrites({
          truncation:
            retryTruncateResult ?
              {
                removedMessageCount: retryTruncateResult.removedMessageCount,
                originalTokens: retryTruncateResult.originalTokens,
                compactedTokens: retryTruncateResult.compactedTokens,
                processingTimeMs: retryTruncateResult.processingTimeMs,
              }
            : undefined,
          rewrittenMessages: newPayload.messages as unknown as Array<MessageContent>,
          rewrittenSystem: typeof newPayload.system === "string" ? newPayload.system : undefined,
          messageMapping: retryMessageMapping,
        })

        // Update tracking tags
        if (reqCtx.tuiLogId) {
          const retryAttempt = (meta?.attempt as number | undefined) ?? 1
          const retryTags = ["truncated", `retry-${retryAttempt}`]
          if (newPayload.thinking && newPayload.thinking.type !== "disabled")
            retryTags.push(`thinking:${newPayload.thinking.type}`)
          tuiLogger.updateRequest(reqCtx.tuiLogId, { tags: retryTags })
        }
      },
    })

    const response = result.response
    const effectivePayload = result.effectivePayload as MessagesPayload

    // Check if response is streaming (AsyncIterable)
    if (Symbol.asyncIterator in (response as object)) {
      consola.debug("Streaming response from Copilot (direct Anthropic)")
      reqCtx.transition("streaming")

      return streamSSE(c, async (stream) => {
        const clientAbort = new AbortController()
        stream.onAbort(() => clientAbort.abort())

        await handleDirectAnthropicStreamingResponse({
          stream,
          response: response as AsyncIterable<ServerSentEventMessage>,
          anthropicPayload: effectivePayload,
          reqCtx,
          clientAbortSignal: clientAbort.signal,
        })
      })
    }

    // Non-streaming response
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, reqCtx, truncateResult)
  } catch (error) {
    reqCtx.fail(anthropicPayload.model, error)
    throw error
  }
}

// ============================================================================
// Response handlers (streaming / non-streaming)
// ============================================================================

/** Options for handleDirectAnthropicStreamingResponse */
interface DirectAnthropicStreamHandlerOptions {
  stream: SSEStreamingApi
  response: AsyncIterable<ServerSentEventMessage>
  anthropicPayload: MessagesPayload
  reqCtx: RequestContext
  /** Abort signal that fires when the downstream client disconnects */
  clientAbortSignal?: AbortSignal
}

/** Handle streaming direct Anthropic response (passthrough SSE events) */
async function handleDirectAnthropicStreamingResponse(opts: DirectAnthropicStreamHandlerOptions) {
  const { stream, response, anthropicPayload, reqCtx, clientAbortSignal } = opts
  const acc = createAnthropicStreamAccumulator()

  // Repetition detection — feed text deltas and log warning on first detection
  const checkRepetition = createStreamRepetitionChecker(anthropicPayload.model)

  // SSE event recording for debugging (excludes high-volume content_block_delta and ping)
  const sseEvents: Array<SseEventRecord> = []

  // Streaming metrics for TUI footer and debug timing
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0
  let currentBlockType = ""
  let firstEventLogged = false

  // Optional tool_search block filter — when enabled, strips the internal
  // tool_search_tool_regex server_tool_use + tool_search_tool_result blocks
  // from the stream before forwarding to client.
  const toolSearchFilter = state.filterToolSearchBlocks ? createToolSearchBlockFilter() : null

  try {
    for await (const { raw: rawEvent, parsed } of processAnthropicStream(response, acc, clientAbortSignal)) {
      const dataLen = rawEvent.data?.length ?? 0
      bytesIn += dataLen
      eventsIn++

      // Record non-delta SSE events for history debugging
      if (parsed && parsed.type !== "content_block_delta" && parsed.type !== "ping") {
        sseEvents.push({
          offsetMs: Date.now() - streamStartMs,
          type: parsed.type,
          data: parsed,
        })
      }

      // Debug: log first event arrival (measures TTFB from stream perspective)
      if (!firstEventLogged) {
        const eventType = parsed?.type ?? "keepalive"
        consola.debug(`[Stream] First event at +${Date.now() - streamStartMs}ms (${eventType})`)
        firstEventLogged = true
      }

      // Debug: log content block boundaries with timing
      if (parsed?.type === "content_block_start") {
        currentBlockType = (parsed.content_block as { type: string }).type
        consola.debug(`[Stream] Block #${parsed.index} start: ${currentBlockType} at +${Date.now() - streamStartMs}ms`)
      } else if (parsed?.type === "content_block_stop") {
        const offset = Date.now() - streamStartMs
        consola.debug(
          `[Stream] Block #${parsed.index} stop (${currentBlockType}) at +${offset}ms, cumulative ↓${bytesIn}B ${eventsIn}ev`,
        )
        currentBlockType = ""
      }

      // Update TUI footer with streaming progress
      if (reqCtx.tuiLogId) {
        tuiLogger.updateRequest(reqCtx.tuiLogId, {
          streamBytesIn: bytesIn,
          streamEventsIn: eventsIn,
          streamBlockType: currentBlockType,
        })
      }

      // Check for repetitive output in text deltas
      if (parsed?.type === "content_block_delta") {
        const delta = parsed.delta as { type: string; text?: string }
        if (delta.type === "text_delta" && delta.text) {
          checkRepetition(delta.text)
        }
      }

      // Forward event to client, optionally filtering tool_search blocks
      const forwardData =
        toolSearchFilter ? toolSearchFilter.rewriteEvent(parsed, rawEvent.data ?? "") : (rawEvent.data ?? "")
      if (forwardData === null) continue

      await stream.writeSSE({
        data: forwardData,
        event: rawEvent.event,
        id: rawEvent.id !== undefined ? String(rawEvent.id) : undefined,
        retry: rawEvent.retry,
      })
    }

    // Debug: stream completion summary
    consola.debug(`[Stream] Completed: ↓${bytesIn}B ${eventsIn}ev in ${Date.now() - streamStartMs}ms`)

    // Record SSE events for history debugging (must be before complete/fail which calls toHistoryEntry)
    reqCtx.setSseEvents(sseEvents)

    if (acc.streamError) {
      reqCtx.fail(acc.model || anthropicPayload.model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`))
    } else {
      const responseData = buildAnthropicResponseData(acc, anthropicPayload.model)
      reqCtx.complete(responseData)
    }
  } catch (error) {
    consola.error("Direct Anthropic stream error:", error)
    reqCtx.fail(acc.model || anthropicPayload.model, error)

    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorType = error instanceof StreamIdleTimeoutError ? "timeout_error" : "api_error"
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({
        type: "error",
        error: { type: errorType, message: errorMessage },
      }),
    })
  }
}

/** Handle non-streaming direct Anthropic response */
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  reqCtx: RequestContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
) {
  reqCtx.complete({
    success: true,
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
    },
    stop_reason: response.stop_reason ?? undefined,
    content: { role: "assistant", content: response.content },
  })

  // Add truncation marker to response if verbose mode and truncation occurred
  let finalResponse = response
  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToResponse(response, marker)
  }

  // Optionally strip internal tool_search blocks
  if (state.filterToolSearchBlocks) {
    finalResponse = filterToolSearchBlocksFromResponse(finalResponse)
  }

  return c.json(finalResponse)
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert SanitizationStats to the format expected by rewrites */
function toSanitizationInfo(stats: SanitizationStats) {
  return {
    totalBlocksRemoved: stats.totalBlocksRemoved,
    orphanedToolUseCount: stats.orphanedToolUseCount,
    orphanedToolResultCount: stats.orphanedToolResultCount,
    fixedNameCount: stats.fixedNameCount,
    emptyTextBlocksRemoved: stats.emptyTextBlocksRemoved,
    systemReminderRemovals: stats.systemReminderRemovals,
  }
}

// ============================================================================
// Tool search block filter (gated by state.filterToolSearchBlocks)
// ============================================================================

const TOOL_SEARCH_TOOL_NAME = "tool_search_tool_regex"
const TOOL_SEARCH_RESULT_TYPE = "tool_search_tool_result"

/** Check if a content block is an internal tool_search block */
function isToolSearchBlock(block: { type: string; name?: string }): boolean {
  if (block.type === "server_tool_use" && block.name === TOOL_SEARCH_TOOL_NAME) return true
  if (block.type === TOOL_SEARCH_RESULT_TYPE) return true
  return false
}

/**
 * Filters tool_search blocks from the SSE stream before forwarding to the client.
 * Handles index remapping so block indices remain dense/sequential after filtering.
 */
function createToolSearchBlockFilter() {
  const filteredIndices = new Set<number>()
  const clientIndexMap = new Map<number, number>()
  let nextClientIndex = 0

  function getClientIndex(apiIndex: number): number {
    let idx = clientIndexMap.get(apiIndex)
    if (idx === undefined) {
      idx = nextClientIndex++
      clientIndexMap.set(apiIndex, idx)
    }
    return idx
  }

  return {
    /** Returns rewritten data to forward, or null to suppress the event */
    rewriteEvent(parsed: StreamEvent | undefined, rawData: string): string | null {
      if (!parsed) return rawData

      if (parsed.type === "content_block_start") {
        const block = parsed.content_block as { type: string; name?: string }
        if (isToolSearchBlock(block)) {
          filteredIndices.add(parsed.index)
          return null
        }
        if (filteredIndices.size === 0) {
          getClientIndex(parsed.index)
          return rawData
        }
        const clientIndex = getClientIndex(parsed.index)
        if (clientIndex === parsed.index) return rawData
        const obj = JSON.parse(rawData) as Record<string, unknown>
        obj.index = clientIndex
        return JSON.stringify(obj)
      }

      if (parsed.type === "content_block_delta" || parsed.type === "content_block_stop") {
        if (filteredIndices.has(parsed.index)) return null
        if (filteredIndices.size === 0) return rawData
        const clientIndex = getClientIndex(parsed.index)
        if (clientIndex === parsed.index) return rawData
        const obj = JSON.parse(rawData) as Record<string, unknown>
        obj.index = clientIndex
        return JSON.stringify(obj)
      }

      return rawData
    },
  }
}

/** Filter tool_search blocks from a non-streaming response */
function filterToolSearchBlocksFromResponse(response: AnthropicMessageResponse): AnthropicMessageResponse {
  const filtered = response.content.filter((block: { type: string; name?: string }) => !isToolSearchBlock(block))

  if (filtered.length === response.content.length) return response
  return { ...response, content: filtered }
}
