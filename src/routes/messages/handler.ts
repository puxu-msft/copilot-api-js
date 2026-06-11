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
import { HTTPError } from "~/lib/error"
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
import { tuiLogger } from "~/lib/tui"

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
  const reqCtx = manager.create({
    endpoint: "anthropic-messages",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers),
    tuiLogId,
    rawPath: c.req.path,
  })
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

    return dispatchAnthropicResponse(c, result, reqCtx, truncateResult)
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(anthropicPayload.model, error)
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

  // Set initial tracking tags for log display
  if (reqCtx.tuiLogId) {
    const tags: Array<string> = []
    if (initialSanitized.thinking && initialSanitized.thinking.type !== "disabled") tags.push(`thinking:${initialSanitized.thinking.type}`)
    if (tags.length > 0) tuiLogger.updateRequest(reqCtx.tuiLogId, { tags })
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

  // Update tracking tags. Beta retries (probe / explicit-list) surface which
  // betas were stripped this attempt; other retries keep existing labeling.
  if (reqCtx.tuiLogId) {
    const retryAttempt = (meta?.attempt as number | undefined) ?? 1
    const strippedBetas = (meta?.probedBetas ?? meta?.strippedBetas) as Array<string> | undefined
    const retryTags =
      strippedBetas && strippedBetas.length > 0 ? [`beta-strip:${strippedBetas.join(",")}`, `retry-${retryAttempt}`] : ["truncated", `retry-${retryAttempt}`]
    if (newPayload.thinking && newPayload.thinking.type !== "disabled") retryTags.push(`thinking:${newPayload.thinking.type}`)
    tuiLogger.updateRequest(reqCtx.tuiLogId, { tags: retryTags })
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
) {
  const response = result.response
  const effectivePayload = result.effectivePayload as MessagesPayload

  // Streaming responses are AsyncIterable
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

  return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, reqCtx, truncateResult)
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
  const toolInputDecoder = createToolInputStreamDecoder({
    fields: state.decodeToolInputFields,
    all: state.decodeAllToolInputFields,
  })

  const streamState: StreamPumpState = {
    streamStartMs: Date.now(),
    bytesIn: 0,
    eventsIn: 0,
    currentBlockType: "",
    firstEventLogged: false,
  }

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
        stream,
      })
    }

    // Flush any tool_use input the decoder buffered but never saw a stop for
    // (defensive — normal completion always emits content_block_stop).
    for (const ev of toolInputDecoder.flush()) {
      await forwardToClient(ev, undefined, serverToolFilter, stream, forwardedSseEvents, streamState.streamStartMs)
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

    consola.error("Direct Anthropic stream error:", error)

    // Best-effort flush of buffered tool_use deltas before the error frame, so
    // the client doesn't silently lose fragments the decoder was holding. The
    // stream may already be broken (abort/shutdown); ignore failures here.
    try {
      for (const ev of toolInputDecoder.flush()) {
        await forwardToClient(ev, undefined, serverToolFilter, stream, forwardedSseEvents, streamState.streamStartMs)
      }
    } catch {
      // stream already closed — nothing to recover
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    // Shutdown interruption is surfaced as a retryable `overloaded_error` so the
    // client backs off and retries (succeeding against the restarted instance)
    // instead of seeing a silently truncated stream.
    const errorType = anthropicStreamErrorType(error)
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({
        type: "error",
        error: { type: errorType, message: errorMessage },
      }),
    })
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
  stream: SSEStreamingApi
}

/**
 * Process a single upstream SSE event: update counters, record debug info,
 * filter server-tool blocks, and forward to the client. Mutates `streamState`,
 * `sseEvents`, `forwardedSseEvents`, and writes to `stream`.
 */
async function processOneStreamEvent(args: ProcessOneStreamEventArgs): Promise<void> {
  const { rawEvent, parsed, streamState, sseEvents, forwardedSseEvents, reqCtx, checkRepetition, serverToolFilter, toolInputDecoder, stream } = args

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

  // Update TUI footer with streaming progress
  if (reqCtx.tuiLogId) {
    tuiLogger.updateRequest(reqCtx.tuiLogId, {
      streamBytesIn: streamState.bytesIn,
      streamEventsIn: streamState.eventsIn,
      streamBlockType: streamState.currentBlockType,
    })
  }

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
        await forwardToClient(replRaw, repl, serverToolFilter, stream, forwardedSseEvents, streamState.streamStartMs)
      }
      return
    }
  }

  // Forward to client: the tool-input decoder may buffer selected tool_use
  // input deltas and emit a rewritten delta at content_block_stop (0/1/many
  // events out). Each emitted event then passes through the server-tool filter.
  // Pass-through events reuse `parsed`; decoder-emitted events are re-parsed.
  for (const ev of toolInputDecoder.processEvent(parsed, rawEvent)) {
    await forwardToClient(ev, ev === rawEvent ? parsed : undefined, serverToolFilter, stream, forwardedSseEvents, streamState.streamStartMs)
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
  stream: SSEStreamingApi,
  forwardedSseEvents: Array<SseEventRecord>,
  streamStartMs: number,
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

  await stream.writeSSE({
    data: forwardData,
    event: ev.event,
    id: ev.id !== undefined ? String(ev.id) : undefined,
    retry: ev.retry,
  })
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
  finalResponse = decodeToolInputBlocksInResponse(finalResponse, {
    fields: state.decodeToolInputFields,
    all: state.decodeAllToolInputFields,
  })

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
