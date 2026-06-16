/**
 * Anthropic /v1/messages route handler.
 * Parses payload, resolves model, processes system prompt,
 * and orchestrates completion (streaming / non-streaming).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import {
  //
  SSEStreamingApi,
  streamSSE,
} from "hono/streaming"

import type {
  //
  HeadersCapture,
  RequestContext,
} from "~/lib/context/request"
import type {
  //
  MessageContent,
  ToolDefinition,
} from "~/lib/history"
import type {
  //
  PreprocessInfo,
  SseEventRecord,
} from "~/lib/history/store"
import type {
  //
  MessagesPayload,
  StreamEvent,
} from "~/types/api/anthropic"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import {
  //
  type AnthropicAutoTruncateResult,
} from "~/lib/anthropic/auto-truncate"
import {
  //
  type AnthropicMessageResponse,
} from "~/lib/anthropic/client"
import {
  //
  createToolInputStreamDecoder,
  decodeToolInputBlocksInResponse,
  type ToolInputStreamDecoder,
} from "~/lib/anthropic/decode-tool-input"
import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { preprocessTools } from "~/lib/anthropic/message-tools"
import {
  //
  type AnthropicSanitizeFn,
  runAnthropicPipeline,
} from "~/lib/anthropic/pipeline"
import {
  //
  preprocessAnthropicMessages,
  sanitizeAnthropicMessages,
  type SanitizationStats,
} from "~/lib/anthropic/sanitize"
import {
  //
  applyAnthropicToolNameSanitization,
  buildAnthropicToolNameMapper,
} from "~/lib/anthropic/sanitize/tool-name-sanitize"
import {
  //
  createServerToolBlockFilter,
  filterServerToolBlocksFromResponse,
  logServerToolBlock,
  logServerToolBlocks,
  restoreToolNamesInResponse,
} from "~/lib/anthropic/server-tool-filter"
import {
  //
  processAnthropicStream,
} from "~/lib/anthropic/stream"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { applyThinkingSignatureCompat } from "~/lib/anthropic/thinking-signature-compat"
import {
  //
  handleWarmupRequest,
  isWarmupRequest,
} from "~/lib/anthropic/warmup"
import { payloadHasWebSearch } from "~/lib/anthropic/web-search"
import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  formatErrorWithCause,
  HTTPError,
} from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import { getSessionIdFromHeaders } from "~/lib/history/store"
import { resolveModelName } from "~/lib/models/resolver"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import {
  //
  buildAnthropicResponseData,
  createTruncationMarker,
  prependMarkerToResponse,
} from "~/lib/request"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { state } from "~/lib/state"
import {
  //
  classifyStreamError,
} from "~/lib/stream"
import { processAnthropicSystem } from "~/lib/system-prompt"
import { logUpstreamStreamDisconnect } from "~/lib/upstream-diagnostics"

import { handleWebSearchCompletion } from "./web-search-handler"

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

  // Warmup interception — before any heavy processing (model resolution, context creation, etc.)
  if (state.warmupPolicy !== "allow" && isWarmupRequest(anthropicPayload)) {
    return handleWarmupRequest(c, anthropicPayload, state.warmupPolicy)
  }

  // Snapshot the inbound payload BEFORE any mutation (model resolution,
  // system processing, message preprocessing). This is what we record as
  // the request's "original" — handlers below intentionally rewrite
  // anthropicPayload in place, so without this snapshot the history view
  // would show a half-processed payload labeled as the user's raw input,
  // and auto-truncate's "re-truncate from original" path would compound
  // edits that already happened on the wire.
  const originalSnapshot = structuredClone(anthropicPayload)

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
  const contentLengthHeader = c.req.header("content-length")
  const reqBodySize = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined
  const reqCtx = manager.create({
    endpoint: "anthropic-messages",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers),
    rawPath: c.req.path,
    method: c.req.method,
    path: c.req.path,
    ...(reqBodySize !== undefined && Number.isFinite(reqBodySize) && { requestBodySize: reqBodySize }),
  })
  // Expose ctx so observabilityMiddleware can fail-safe finalize on
  // uncaught throws and completeFromHttpStatus on non-streaming returns.
  c.set("requestContext", reqCtx)
  reqCtx.setOriginalRequest({
    // Use client's original model name (before resolution/overrides)
    model: clientModelName ?? originalSnapshot.model,
    messages: originalSnapshot.messages as unknown as Array<MessageContent>,
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools as Array<ToolDefinition> | undefined,
    system: originalSnapshot.system,
    payload: originalSnapshot,
  })
  reqCtx.setInboundRequestHeaders(captureInboundHeaders(c.req.raw.headers))

  // Build the per-request tool-name sanitization mapper from the client's
  // ORIGINAL custom tools — before preprocessTools injects stubs/tool_search,
  // so injected stubs and server tools are never renamed. No-op (null) when the
  // feature is disabled or no name needs rewriting. Response handlers read this
  // back from reqCtx to restore upstream names to the client's originals.
  const selectedModelForMapper = state.modelIndex.get(anthropicPayload.model)
  reqCtx.setToolNameMapper(buildAnthropicToolNameMapper(anthropicPayload.tools, anthropicPayload.model, selectedModelForMapper?.vendor))

  // Publish model resolution to the observability bus. Replaces the legacy
  // `tuiLogger.updateRequest({ model, clientModel })` direct call — sinks
  // (ConsoleSink / WsSink) receive `request.model_resolved` via the bus and
  // update their renderings. The legacy tuiLogger track is still kept by
  // main.ts:initConsolaReporter for now; commit 4 deletes it.
  reqCtx.setResolvedModel({
    resolved: anthropicPayload.model,
    ...(clientModelName !== undefined && { client: clientModelName }),
  })

  // Phase 1: One-time preprocessing (idempotent, before routing)
  const preprocessed = preprocessAnthropicMessages(anthropicPayload.messages)
  anthropicPayload.messages = preprocessed.messages
  const preprocessInfo = {
    strippedReadTagCount: preprocessed.strippedReadTagCount,
    dedupedToolCallCount: preprocessed.dedupedToolCallCount,
  }

  // Web search double-hop interception — only when enabled AND the request
  // carries a native web_search server tool (or Claude Code's WebSearch). When
  // disabled this is a single boolean check (fully short-circuited, zero behavior
  // change). The orchestrator runs two non-streaming model hops + a real search
  // and emits a synthesized response with visible server_tool_use + result blocks.
  if (state.webSearchEnabled && payloadHasWebSearch(anthropicPayload)) {
    consola.debug("[WebSearch] Intercepting request with native web_search tool")
    const selectedModel = state.modelIndex.get(anthropicPayload.model)
    return handleWebSearchCompletion(c, anthropicPayload, reqCtx, selectedModel, preprocessInfo)
  }

  return handleDirectAnthropicCompletion(c, anthropicPayload, reqCtx, preprocessInfo)
}

// ============================================================================
// Direct Anthropic completion orchestration
// ============================================================================

// Handle completion using direct Anthropic API (no translation needed)
export async function handleDirectAnthropicCompletion(c: Context, anthropicPayload: MessagesPayload, reqCtx: RequestContext, preprocessInfo: PreprocessInfo) {
  consola.debug("Using direct Anthropic API path for model:", anthropicPayload.model)

  // Find model for auto-truncate and usage adjustment
  const selectedModel = state.modelIndex.get(anthropicPayload.model)

  const { initialSanitized, initialSanitizationInfo } = runInitialSanitizationAndRecord(anthropicPayload, reqCtx, preprocessInfo)

  const headersCapture: HeadersCapture = {}
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined

  // Hoisted client-abort: fires on inbound HTTP disconnect AND (for the
  // streaming branch in dispatchAnthropicResponse) on `streamSSE`'s onAbort.
  // Passed into the pipeline so non-streaming requests also tear down the
  // upstream fetch when the client disconnects — without this bridge an
  // abandoned non-stream request runs to `timeouts.response_header`.
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)

  // Direct path sanitize: full pipeline (preprocessTools + tool-name + sanitize),
  // shared by the adapter's sanitize and auto-truncate's resanitize.
  const directSanitize: AnthropicSanitizeFn = (p) => sanitizeAnthropicMessages(applyAnthropicToolNameSanitization(preprocessTools(p), reqCtx.toolNameMapper))

  // Track truncation result for non-streaming response marker
  let truncateResult: AnthropicAutoTruncateResult | undefined

  try {
    const result = await runAnthropicPipeline({
      payload: initialSanitized,
      originalPayload: anthropicPayload,
      selectedModel,
      clientAnthropicBeta,
      sanitize: directSanitize,
      resanitize: directSanitize,
      headersCapture,
      requestContext: reqCtx,
      clientAbortSignal: clientAbort.signal,
      maxRetries: state.autoTruncateMaxRetries,
      onRetry: (_attempt, _strategyName, newPayload, meta) => {
        const retryTruncateResult = meta?.truncateResult as AnthropicAutoTruncateResult | undefined
        if (retryTruncateResult) {
          truncateResult = retryTruncateResult
        }
        recordRetryPipelineState({
          reqCtx,
          anthropicPayload,
          newPayload,
          meta,
          preprocessInfo,
          initialSanitizationInfo,
          retryTruncateResult,
        })
      },
    })

    // Capture HTTP headers from the final attempt for history recording
    reqCtx.setHttpHeaders(headersCapture)

    return dispatchAnthropicResponse(c, result, reqCtx, truncateResult, clientAbort, detachClientAbort)
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(anthropicPayload.model, error)
    detachClientAbort()
    throw error
  }
}

/**
 * Preprocess tools + run initial sanitization, then record pipeline info /
 * mapping / initial tracking tags onto the request context. Returns the
 * sanitized payload and the sanitization info envelope for later retry
 * aggregation.
 */
function runInitialSanitizationAndRecord(
  anthropicPayload: MessagesPayload,
  reqCtx: RequestContext,
  preprocessInfo: PreprocessInfo,
): { initialSanitized: MessagesPayload; initialSanitizationInfo: ReturnType<typeof toSanitizationInfo> } {
  // Preprocess tools: inject stubs for history-referenced tools, set defer_loading,
  // add tool_search. Must run BEFORE sanitize — processToolBlocks (in sanitize) uses
  // the tools array to validate tool_use references in messages.
  const toolPreprocessed = preprocessTools(anthropicPayload)

  // Apply tool-name sanitization (rename client-original custom tool names to
  // their upstream form) BEFORE sanitize, so processToolBlocks' name-casing fix
  // sees the already-renamed (upstream) names and the two rewrites don't fight.
  const toolNameSanitized = applyAnthropicToolNameSanitization(toolPreprocessed, reqCtx.toolNameMapper)

  // Always sanitize messages to filter orphaned tool_result/tool_use blocks
  const { payload: initialSanitized, stats: sanitizationStats } = sanitizeAnthropicMessages(toolNameSanitized)
  const initialSanitizationInfo = toSanitizationInfo(sanitizationStats)

  // Record sanitization/preprocessing if anything was modified
  const hasPreprocessing = preprocessInfo.dedupedToolCallCount > 0 || preprocessInfo.strippedReadTagCount > 0
  if (sanitizationStats.totalBlocksRemoved > 0 || sanitizationStats.systemReminderRemovals > 0 || sanitizationStats.fixedNameCount > 0 || hasPreprocessing) {
    const messageMapping = buildMessageMapping(anthropicPayload.messages, initialSanitized.messages)
    reqCtx.setPipelineInfo({
      preprocessing: preprocessInfo,
      sanitization: [initialSanitizationInfo],
      messageMapping,
    })
  }

  // Publish "thinking" feature when enabled. Replaces the legacy
  // `tuiLogger.updateRequest({ tags: ["thinking:..."] })` direct call —
  // ConsoleSink renders it as the same `(thinking:adaptive)` suffix on
  // the [ OK ] line via `renderFeatureTag` in observability/sinks/console.ts.
  if (initialSanitized.thinking && initialSanitized.thinking.type !== "disabled") {
    reqCtx.recordFeature("thinking", { type: initialSanitized.thinking.type })
  }

  return { initialSanitized, initialSanitizationInfo }
}

interface RecordRetryPipelineStateArgs {
  reqCtx: RequestContext
  anthropicPayload: MessagesPayload
  newPayload: MessagesPayload
  meta: Record<string, unknown> | undefined
  preprocessInfo: PreprocessInfo
  initialSanitizationInfo: ReturnType<typeof toSanitizationInfo>
  retryTruncateResult: AnthropicAutoTruncateResult | undefined
}

/** Record sanitization / truncation / mapping for a retried payload. */
function recordRetryPipelineState(args: RecordRetryPipelineStateArgs): void {
  const { reqCtx, anthropicPayload, newPayload, meta, preprocessInfo, initialSanitizationInfo, retryTruncateResult } = args

  const retrySanitization = meta?.sanitization as SanitizationStats | undefined
  const allSanitization = [initialSanitizationInfo, ...(retrySanitization ? [toSanitizationInfo(retrySanitization)] : [])]
  const retryMessageMapping = buildMessageMapping(anthropicPayload.messages, newPayload.messages)
  reqCtx.setPipelineInfo({
    preprocessing: preprocessInfo,
    sanitization: allSanitization,
    truncation:
      retryTruncateResult ?
        {
          wasTruncated: true,
          removedMessageCount: retryTruncateResult.removedMessageCount,
          originalTokens: retryTruncateResult.originalTokens,
          compactedTokens: retryTruncateResult.compactedTokens,
          processingTimeMs: retryTruncateResult.processingTimeMs,
        }
      : undefined,
    messageMapping: retryMessageMapping,
  })

  // Update tracking tags. Beta retries surface which betas were stripped this
  // attempt as a sticky feature tag; truncation is a sticky feature tag.
  // Retry counter / per-attempt diagnostics are emitted as [RETRY-n] lines
  // by `executeRequestPipeline` — kept out of the final outcome's tag list
  // to avoid duplicating the same information.
  // Publish features observed on this retry attempt. Replaces the legacy
  // `tuiLogger.updateRequest({ tags: [...] })` direct call. Per-attempt
  // retry counter / diagnostics are emitted as [RETRY-n] lines by
  // `executeRequestPipeline` — kept out of feature events to avoid
  // duplicating the same information.
  const strippedBetas = (meta?.probedBetas ?? meta?.strippedBetas) as Array<string> | undefined
  if (strippedBetas && strippedBetas.length > 0) {
    reqCtx.recordFeature("beta-stripped", { betas: strippedBetas })
  } else {
    reqCtx.recordFeature("truncated")
  }
  if (newPayload.thinking && newPayload.thinking.type !== "disabled") {
    reqCtx.recordFeature("thinking", { type: newPayload.thinking.type })
  }
}

/**
 * Dispatch the upstream response to the streaming or non-streaming handler.
 * For streaming responses, also transitions reqCtx to "streaming" before
 * handing off (so the consumer sees state changes in order).
 */
function dispatchAnthropicResponse(
  c: Context,
  result: { response: unknown; effectivePayload: unknown },
  reqCtx: RequestContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
  clientAbort: AbortController,
  detachClientAbort: () => void,
) {
  const response = result.response
  const effectivePayload = result.effectivePayload as MessagesPayload

  // Streaming responses are AsyncIterable
  if (Symbol.asyncIterator in (response as object)) {
    consola.debug("Streaming response from Copilot (direct Anthropic)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      // streamSSE's onAbort is the second trigger source (the first is the
      // inbound HTTP signal already bridged in the caller). Both flip the
      // same controller, so any disconnect path tears down upstream.
      stream.onAbort(() => clientAbort.abort())

      try {
        await handleDirectAnthropicStreamingResponse({
          stream,
          response: response as AsyncIterable<ServerSentEventMessage>,
          anthropicPayload: effectivePayload,
          reqCtx,
          clientAbortSignal: clientAbort.signal,
        })
      } finally {
        detachClientAbort()
      }
    })
  }

  try {
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, reqCtx, truncateResult)
  } finally {
    detachClientAbort()
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

/** Map a streaming error to its Anthropic SSE `error.type`. Shutdown → retryable overloaded_error. */
function anthropicStreamErrorType(error: unknown): string {
  switch (classifyStreamError(error)) {
    case "idle-timeout": {
      return "timeout_error"
    }
    case "shutdown": {
      return "overloaded_error"
    }
    default: {
      return "api_error"
    }
  }
}

/**
 * Extract live-stream signals and emit a detailed upstream-disconnect log.
 *
 * Pulls the diagnostic signals out of the handler-internal stream state and
 * delegates formatting/emission to `logUpstreamStreamDisconnect`. The `silence`
 * it surfaces (gap between the last upstream frame and the disconnect) is the
 * smoking gun for "died during a silent thinking stall".
 */
function logUpstreamStreamError(
  error: unknown,
  ctx: {
    model: string
    streamState: StreamPumpState
    acc: ReturnType<typeof createAnthropicStreamAccumulator>
    sseEvents: Array<SseEventRecord>
  },
): void {
  const { model, streamState, acc, sseEvents } = ctx
  const last = sseEvents.at(-1)
  const kind = classifyStreamError(error)
  logUpstreamStreamDisconnect({
    model,
    kindLabel: kind === "other" ? "transport-close" : kind,
    detail: error instanceof Error ? formatErrorWithCause(error) : String(error),
    elapsedMs: Date.now() - streamState.streamStartMs,
    frames: sseEvents.length,
    bytes: streamState.bytesIn,
    lastFrameType: last?.type,
    lastFrameOffsetMs: last?.offsetMs ?? 0,
    stuckBlockType: streamState.currentBlockType,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
  })
}

/** Handle streaming direct Anthropic response (passthrough SSE events). Exported for handler-level abort/settle tests. */
export async function handleDirectAnthropicStreamingResponse(opts: DirectAnthropicStreamHandlerOptions) {
  const { stream, response, anthropicPayload, reqCtx, clientAbortSignal } = opts
  const acc = createAnthropicStreamAccumulator()

  // Repetition detection — feed text deltas and log warning on first detection
  const checkRepetition = createStreamRepetitionChecker(anthropicPayload.model)

  // Upstream SSE event recording (verbatim raw frames + keepalives) for history.
  const sseEvents: Array<SseEventRecord> = []
  // Forwarded SSE frames — what the client ACTUALLY received after server-tool
  // filtering / tool-name restoration / tool-input decoding. Compared against
  // `sseEvents` (upstream-original) this is the "sent vs received" diagnostic.
  const forwardedSseEvents: Array<SseEventRecord> = []

  // Server tool block filter — always active, matching vscode-copilot-chat behavior.
  // Server tool blocks (server_tool_use, tool_search_tool_result, etc.) are server-side
  // artifacts that clients don't expect. The reference implementation (vscode-copilot-chat)
  // intercepts these unconditionally and never forwards raw blocks to the consumer.
  // When tool-name sanitization is active, this filter also restores client
  // tool_use names (upstream → original) on the forwarded stream.
  const serverToolFilter = createServerToolBlockFilter(reqCtx.toolNameMapper)

  // Tool input decoder — rewrites stringified-JSON fields in selected tool_use
  // blocks on the forwarded stream only. History (sseEvents + accumulator) keeps
  // the original upstream form, so the anomaly stays visible.
  const toolInputDecoder = createToolInputStreamDecoder(
    {
      fields: state.decodeToolInputFields,
      all: state.decodeAllToolInputFields,
    },
    { backfillAskUserQuestionHeader: state.backfillQuestionFromHeader },
  )

  const streamState: StreamPumpState = {
    streamStartMs: Date.now(),
    bytesIn: 0,
    eventsIn: 0,
    currentBlockType: "",
    firstEventLogged: false,
  }

  // Synthetic SSE keepalive (anthropic.fake_sse_heartbeat, seconds; 0 = off).
  // Emits Anthropic-protocol `event: ping` whenever no real frame has been
  // forwarded for >= intervalMs, so clients (e.g. Claude Code ~258s) don't
  // disconnect while upstream stalls mid-stream (e.g. opus-4.8 adaptive
  // thinking that goes silent after content_block_start). Heartbeats are
  // proxy-originated: they do NOT reset the upstream idle-timeout (a dead
  // upstream still fails via `timeouts.stream_idle`), and they are recorded
  // ONLY in `forwardedSseEvents`, never in the raw upstream `sseEvents`.
  const heartbeat = startForwardedSseHeartbeat({
    intervalSec: state.anthropicFakeSseHeartbeat,
    stream,
    forwardedSseEvents,
    streamState,
    clientAbortSignal,
  })

  try {
    for await (const { raw: rawEvent, parsed } of processAnthropicStream(response, acc, clientAbortSignal)) {
      await processOneStreamEvent({
        rawEvent,
        parsed,
        streamState,
        sseEvents,
        forwardedSseEvents,
        reqCtx,
        checkRepetition,
        serverToolFilter,
        toolInputDecoder,
        heartbeat,
      })
    }

    // Flush any tool_use input the decoder buffered but never saw a stop for
    // (defensive — normal completion always emits content_block_stop).
    for (const ev of toolInputDecoder.flush()) {
      await forwardToClient(ev, undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
    }

    // Debug: stream completion summary
    const summaryParts = [`↓${streamState.bytesIn}B ${streamState.eventsIn}ev in ${Date.now() - streamState.streamStartMs}ms`]
    if (acc.toolSearchRequests > 0) summaryParts.push(`tool_search:${acc.toolSearchRequests}`)
    consola.debug(`[Stream] Completed: ${summaryParts.join(" ")}`)

    // Record SSE events for history debugging (must be before complete/fail which calls toHistoryEntry)
    reqCtx.setSseEvents(sseEvents)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })

    if (acc.streamError) {
      // Upstream reported an error mid-stream (e.g. overloaded_error, rate_limit,
      // content filter). This is a terminal `error` SSE event, not a thrown/
      // transport failure, so it never reaches the catch below — log it here for
      // operator visibility, mirroring the catch block's console.error. Without
      // this the failure would only land in history + the forwarded client frame.
      consola.error(`[Stream] Upstream error for ${acc.model || anthropicPayload.model}: ${acc.streamError.type} — ${acc.streamError.message}`)
      reqCtx.fail(acc.model || anthropicPayload.model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`))
    } else {
      const responseData = buildAnthropicResponseData(acc, anthropicPayload.model)
      reqCtx.complete(responseData)
    }
  } catch (error) {
    // Record what was streamed/forwarded so far BEFORE settling history, so a
    // mid-stream interruption still leaves the partial wire timeline (原则3).
    reqCtx.setSseEvents(sseEvents)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })

    // Uniform terminal settle: client disconnect → `aborted` (return, don't
    // write to the closed stream); else → `fail()` and emit the error frame.
    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens }, stop_reason: acc.stopReason || undefined }
    if (settleStreamingFailure({ reqCtx, error, model: acc.model || anthropicPayload.model, partial })) {
      consola.debug("[Stream] Client disconnected mid-stream — recording aborted")
      return
    }

    logUpstreamStreamError(error, { model: acc.model || anthropicPayload.model, streamState, acc, sseEvents })

    // Best-effort flush of buffered tool_use deltas before the error frame, so
    // the client doesn't silently lose fragments the decoder was holding. The
    // stream may already be broken (abort/shutdown); ignore failures here.
    try {
      for (const ev of toolInputDecoder.flush()) {
        await forwardToClient(ev, undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
      }
    } catch {
      // stream already closed — nothing to recover
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    // Shutdown interruption is surfaced as a retryable `overloaded_error` so the
    // client backs off and retries (succeeding against the restarted instance)
    // instead of seeing a silently truncated stream.
    const errorType = anthropicStreamErrorType(error)
    await heartbeat.writeSerialized({
      event: "error",
      data: JSON.stringify({
        type: "error",
        error: { type: errorType, message: errorMessage },
      }),
    })
  } finally {
    heartbeat.stop()
  }
}

/** Mutable counters/state threaded through the streaming pump. */
interface StreamPumpState {
  streamStartMs: number
  bytesIn: number
  eventsIn: number
  currentBlockType: string
  firstEventLogged: boolean
}

interface ProcessOneStreamEventArgs {
  rawEvent: ServerSentEventMessage
  parsed: StreamEvent | undefined
  streamState: StreamPumpState
  sseEvents: Array<SseEventRecord>
  forwardedSseEvents: Array<SseEventRecord>
  reqCtx: RequestContext
  checkRepetition: (text: string) => void
  serverToolFilter: ReturnType<typeof createServerToolBlockFilter>
  toolInputDecoder: ToolInputStreamDecoder
  heartbeat: ForwardedSseHeartbeat
}

/**
 * Process a single upstream SSE event: update counters, record debug info,
 * filter server-tool blocks, and forward to the client. Mutates `streamState`,
 * `sseEvents`, `forwardedSseEvents`, and writes to `stream`.
 */
async function processOneStreamEvent(args: ProcessOneStreamEventArgs): Promise<void> {
  const { rawEvent, parsed, streamState, sseEvents, forwardedSseEvents, reqCtx, checkRepetition, serverToolFilter, toolInputDecoder, heartbeat } = args

  const dataLen = rawEvent.data?.length ?? 0
  streamState.bytesIn += dataLen
  streamState.eventsIn++

  // Faithfully record every raw upstream event, including `ping` keepalives —
  // their timing reveals upstream idle gaps (e.g. pings during long thinking).
  // Deltas (input_json_delta / thinking_delta / text_delta / signature_delta)
  // are the ONLY original record of what the upstream actually streamed — the
  // accumulated `response.content` is a derived artifact (accumulate →
  // mapAnthropicContentBlocks → safeParseJson) and cannot answer "was the tool_use
  // input empty at the source?". `raw` stores the verbatim upstream `data:` bytes
  // (no parse round-trip); `type` is derived for indexing. Keepalive / unparseable
  // frames are recorded too (timing matters — a signature_delta closing an
  // encrypted thinking block can arrive seconds after content_block_start, a gap
  // only visible if the bracketing keepalives are kept). Required by 原则3
  // (后端存储必须完整,不主动丢弃任何可观测原始数据).
  sseEvents.push({
    offsetMs: Date.now() - streamState.streamStartMs,
    type: parsed?.type ?? rawEvent.event ?? "keepalive",
    raw: rawEvent.data ?? "",
  })

  // Debug: log first event arrival (measures TTFB from stream perspective)
  if (!streamState.firstEventLogged) {
    const eventType = parsed?.type ?? "keepalive"
    consola.debug(`[Stream] First event at +${Date.now() - streamState.streamStartMs}ms (${eventType})`)
    streamState.firstEventLogged = true
  }

  // Debug: log content block boundaries with timing
  if (parsed?.type === "content_block_start") {
    streamState.currentBlockType = (parsed.content_block as { type: string }).type
    consola.debug(`[Stream] Block #${parsed.index} start: ${streamState.currentBlockType} at +${Date.now() - streamState.streamStartMs}ms`)

    // Log server tool information (before filtering, so info is never lost)
    const block = parsed.content_block as unknown as Record<string, unknown> & { type: string }
    logServerToolBlock(block)
  } else if (parsed?.type === "content_block_stop") {
    const offset = Date.now() - streamState.streamStartMs
    consola.debug(
      `[Stream] Block #${parsed.index} stop (${streamState.currentBlockType}) at +${offset}ms, cumulative ↓${streamState.bytesIn}B ${streamState.eventsIn}ev`,
    )
    streamState.currentBlockType = ""
  }

  // Publish streaming progress to the observability bus. Replaces the
  // legacy `tuiLogger.updateRequest({ streamBytesIn/streamEventsIn/...
  // })` direct call — ConsoleSink's footer reads bytesIn/eventsIn/blockType
  // from `request.stream_progress` and renders ` ↓12KB 42ev [thinking]`.
  reqCtx.recordStreamProgress({
    bytesIn: streamState.bytesIn,
    eventsIn: streamState.eventsIn,
    blockType: streamState.currentBlockType,
  })

  // Check for repetitive output in text deltas
  if (parsed?.type === "content_block_delta") {
    const delta = parsed.delta as { type: string; text?: string }
    if (delta.type === "text_delta" && delta.text) {
      checkRepetition(delta.text)
    }
  }

  // Apply the thinking-signature compatibility shim for the "signature embedded
  // in content_block_start" frame some Copilot upstreams send with no
  // signature_delta — re-shaped on the CLIENT-FACING stream only so standard
  // clients keep the signature. The upstream raw frame was already recorded into
  // `sseEvents` above, so history keeps it; only what we forward changes. Thinking
  // frames pass through the tool-input decoder untouched (it only buffers
  // tool_use), so bypassing it for the replacement frames is safe; they still go
  // through forwardToClient for server-tool index remapping consistency.
  if (parsed) {
    const compatFrames = applyThinkingSignatureCompat(parsed, state.thinkingSignatureCompat)
    if (compatFrames) {
      for (const repl of compatFrames) {
        const replRaw: ServerSentEventMessage = { ...rawEvent, data: JSON.stringify(repl) }
        await forwardToClient(replRaw, repl, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
      }
      return
    }
  }

  // Forward to client: the tool-input decoder may buffer selected tool_use
  // input deltas and emit a rewritten delta at content_block_stop (0/1/many
  // events out). Each emitted event then passes through the server-tool filter.
  // Pass-through events reuse `parsed`; decoder-emitted events are re-parsed.
  for (const ev of toolInputDecoder.processEvent(parsed, rawEvent)) {
    await forwardToClient(ev, ev === rawEvent ? parsed : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
  }
}

/** Best-effort parse of an SSE data payload into a StreamEvent (undefined on failure / keepalive). */
function parseStreamEventData(data: string | undefined): StreamEvent | undefined {
  if (!data) return undefined
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return undefined
  }
}

/**
 * Forward one (possibly decoder-rewritten) SSE event to the client, applying
 * the server-tool filter for index remapping / suppression. `knownParsed` is
 * supplied for pass-through events to avoid a redundant re-parse. The frame
 * actually written is also appended to `forwardedSseEvents` (the proxy→client
 * record); suppressed frames (rewriteEvent → null) are recorded by neither.
 */
async function forwardToClient(
  ev: ServerSentEventMessage,
  knownParsed: StreamEvent | undefined,
  serverToolFilter: ReturnType<typeof createServerToolBlockFilter>,
  forwardedSseEvents: Array<SseEventRecord>,
  streamStartMs: number,
  heartbeat: ForwardedSseHeartbeat,
): Promise<void> {
  const evParsed = knownParsed ?? parseStreamEventData(ev.data)
  const forwardData = serverToolFilter.rewriteEvent(evParsed, ev.data ?? "")
  if (forwardData === null) return

  // Record the exact frame the client receives (post-rewrite). evParsed reflects
  // the pre-rewrite parse; the type is stable enough for indexing, and `raw` holds
  // the actual forwarded bytes.
  forwardedSseEvents.push({
    offsetMs: Date.now() - streamStartMs,
    type: evParsed?.type ?? ev.event ?? "keepalive",
    raw: forwardData,
  })

  // Note real-frame activity BEFORE awaiting the write — even if the timer
  // fires while we're awaiting `writeSerialized`, it will see a fresh
  // `lastRealMs` and skip emitting a redundant ping. Serialized via the
  // heartbeat's writer to interleave-protect against the timer callback.
  heartbeat.noteRealFrame()
  await heartbeat.writeSerialized({
    data: forwardData,
    event: ev.event,
    id: ev.id !== undefined ? String(ev.id) : undefined,
    retry: ev.retry,
  })
}

// ============================================================================
// Synthetic SSE heartbeat (anthropic.fake_sse_heartbeat)
// ============================================================================

export interface ForwardedSseHeartbeat {
  /** Serialize a write with any pending heartbeat write, so SSE frame bytes never interleave. */
  writeSerialized: (msg: Parameters<SSEStreamingApi["writeSSE"]>[0]) => Promise<void>
  /** Mark that a real upstream-originated frame was just forwarded (resets the keepalive countdown). */
  noteRealFrame: () => void
  /** Stop the timer. Idempotent. */
  stop: () => void
}

export interface StartHeartbeatOpts {
  intervalSec: number
  stream: SSEStreamingApi
  forwardedSseEvents: Array<SseEventRecord>
  streamState: StreamPumpState
  clientAbortSignal: AbortSignal | undefined
}

/**
 * Start the forwarded-SSE keepalive. When `intervalSec <= 0` this is a no-op
 * pass-through (writes go straight to `stream.writeSSE`, no timer). When > 0,
 * a self-rescheduling timer checks every interval whether at least that many
 * seconds have passed since the last real forwarded frame; if so, it injects
 * an Anthropic-protocol `event: ping` so the client doesn't time out while
 * upstream is silent. Heartbeats are recorded ONLY in `forwardedSseEvents`
 * (the proxy→client diagnostic), never in `sseEvents` (raw upstream record),
 * preserving 原则3 — the upstream timeline stays untouched.
 *
 * All writes (real + heartbeat) go through one shared promise chain so the
 * timer callback and the main pump never interleave their SSE frame bytes.
 * `noteRealFrame()` is called BEFORE awaiting the real write, so a timer
 * firing mid-write sees the fresh timestamp and skips redundant pings.
 */
export function startForwardedSseHeartbeat(opts: StartHeartbeatOpts): ForwardedSseHeartbeat {
  const { intervalSec, stream, forwardedSseEvents, streamState, clientAbortSignal } = opts
  let writeChain: Promise<void> = Promise.resolve()
  const writeSerialized = (msg: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> => {
    const next = writeChain.then(() => stream.writeSSE(msg))
    writeChain = next.catch(() => undefined)
    return next
  }

  if (intervalSec <= 0) {
    return { writeSerialized, noteRealFrame: () => undefined, stop: () => undefined }
  }

  const intervalMs = intervalSec * 1000
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const noteRealFrame = (): void => {
    lastRealMs = Date.now()
  }

  const tick = (): void => {
    if (stopped || clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      // Inject one Anthropic-protocol `ping` keepalive. Standard SDKs treat
      // this as a benign no-op; clients that don't know `ping` still keep the
      // TCP connection alive on byte arrival.
      const pingData = JSON.stringify({ type: "ping" })
      forwardedSseEvents.push({
        offsetMs: Date.now() - streamState.streamStartMs,
        type: "ping",
        raw: pingData,
      })
      // Serialized write — the heartbeat may race the main pump; the shared
      // chain guarantees byte-level non-interleaving. Errors (closed stream)
      // are swallowed: the main pump's next write will hit the same error
      // and route through the existing settle path.
      void writeSerialized({ event: "ping", data: pingData }).catch(() => undefined)
      lastRealMs = Date.now()
      timer = setTimeout(tick, intervalMs)
    } else {
      // Real frame arrived since last check — reschedule for when the
      // remaining gap would reach intervalMs.
      timer = setTimeout(tick, intervalMs - elapsed)
    }
  }
  timer = setTimeout(tick, intervalMs)

  return {
    writeSerialized,
    noteRealFrame,
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/** Handle non-streaming direct Anthropic response */
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  reqCtx: RequestContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
) {
  // Compute the client-facing (rewritten) response first so we can record it as
  // the forwarded state BEFORE complete() finalizes history. complete() itself
  // records the UPSTREAM-original response (response.content), so history keeps
  // both the upstream form and what the client actually received.
  let finalResponse = response

  // Add truncation marker to response if verbose mode and truncation occurred
  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToResponse(response, marker)
  }

  // Filter server tool blocks from non-streaming response (always active)
  logServerToolBlocks(finalResponse.content as unknown as Array<Record<string, unknown> & { type: string }>)
  finalResponse = filterServerToolBlocksFromResponse(finalResponse)

  // Restore client tool_use names (upstream → original) on the client-facing response only.
  finalResponse = restoreToolNamesInResponse(finalResponse, reqCtx.toolNameMapper)

  // Decode stringified-JSON tool_use input fields on the client-facing response only.
  finalResponse = decodeToolInputBlocksInResponse(
    finalResponse,
    {
      fields: state.decodeToolInputFields,
      all: state.decodeAllToolInputFields,
    },
    { backfillAskUserQuestionHeader: state.backfillQuestionFromHeader },
  )

  // Record the forwarded (client-facing) content, then complete() with the
  // upstream-original — both before returning. setForwardedResponse must precede
  // complete() (which emits + builds the history entry).
  reqCtx.setForwardedResponse({ content: { role: "assistant", content: finalResponse.content } })
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
    emptyThinkingBlocksRemoved: stats.emptyThinkingBlocksRemoved,
    systemReminderRemovals: stats.systemReminderRemovals,
  }
}
