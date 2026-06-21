/**
 * Anthropic direct-completion path — the web_search double-hop's second-hop engine.
 *
 * The /v1/messages route runs the v4 driver (`handler-v4.ts`); this file owns NO
 * route (renamed from the former `handler.ts`, which was misleading — it is not the
 * messages handler). It retains `handleDirectAnthropicCompletion` + its subtree
 * (sanitize → pipeline → dispatch → streaming/non-streaming finishing), whose ONLY
 * live caller is the web_search orchestrator (`web-search-handler.ts`, a deferred
 * P2.6 `[bypass]` that does not go through the driver) for the main-model second hop.
 * When web_search migrates onto the driver, this file can shrink / be removed.
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
  PreprocessInfo,
  SseEventRecord,
} from "~/lib/history/store"
import type {
  //
  MessagesPayload,
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
} from "~/lib/anthropic/decode-tool-input"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import {
  //
  type AnthropicSanitizeFn,
  runAnthropicPipeline,
} from "~/lib/anthropic/pipeline"
import {
  //
  createToolCallTextRecoverer,
  extractToolParamTypes,
  recoverToolCallTextInResponse,
} from "~/lib/anthropic/recover-tool-call"
import { runAnthropicRequestRewrites } from "~/lib/anthropic/request-rewrites"
import {
  //
  type SanitizationStats,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import {
  //
  createServerToolBlockFilter,
  filterServerToolBlocksFromResponse,
  logServerToolBlocks,
  restoreToolNamesInResponse,
} from "~/lib/anthropic/server-tool-filter"
import {
  //
  processAnthropicStream,
} from "~/lib/anthropic/stream"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
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
  anthropicStreamErrorType,
  forwardToClient,
  logUpstreamStreamError,
  parseStreamEventData,
  processOneStreamEvent,
  startForwardedSseHeartbeat,
  type StreamPumpState,
} from "./streaming-pump"

// Re-export the forwarded-SSE heartbeat starter so consumers that import it via
// this handler module (web-search-handler.ts, the unit tests) keep working after
// the streaming-pump extraction.
export { startForwardedSseHeartbeat } from "./streaming-pump"

// ============================================================================
// Main entry point — Anthropic /v1/messages completion
// ============================================================================

/**
 * Handle an Anthropic /v1/messages request.
 * Parses payload, resolves model name, processes system prompt,
 * creates RequestContext, and routes to direct Anthropic API.
 */

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

  // Direct path sanitize: the ordered Anthropic request-rewrite chain
  // (tool-preprocess + tool-name + sanitize), shared by the adapter's sanitize
  // and auto-truncate's resanitize. Returns the canonical SanitizeResult.
  const directSanitize: AnthropicSanitizeFn = (p) => runAnthropicRequestRewrites(p, { toolNameMapper: reqCtx.toolNameMapper }).sanitizeResult

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
  // Run the ordered Anthropic request-rewrite chain (tool-preprocess → tool-name
  // → sanitize). Preprocess must precede sanitize — processToolBlocks (in
  // sanitize) validates tool_use references against the tools array — and
  // tool-name precedes sanitize so processToolBlocks' name-casing fix sees the
  // already-renamed upstream names. The registry's `order` keys encode this.
  const { payload: initialSanitized, sanitizeResult } = runAnthropicRequestRewrites(anthropicPayload, { toolNameMapper: reqCtx.toolNameMapper })
  const sanitizationStats = sanitizeResult.stats
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
    return handleDirectAnthropicNonStreamingResponse(c, response as AnthropicMessageResponse, reqCtx, truncateResult, effectivePayload)
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

  const toolCallTextRecoverer = createToolCallTextRecoverer({
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })

  const streamState: StreamPumpState = {
    streamStartMs: Date.now(),
    bytesIn: 0,
    eventsIn: 0,
    currentBlockType: "",
    firstEventLogged: false,
    recoverFeatureLogged: false,
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
        toolCallTextRecoverer,
        heartbeat,
      })
    }

    // Flush any tool_use input the decoder buffered but never saw a stop for
    // (defensive — normal completion always emits content_block_stop).
    for (const rev of toolCallTextRecoverer.flush()) {
      const rp = parseStreamEventData(rev.data)
      for (const ev of toolInputDecoder.processEvent(rp, rev)) {
        await forwardToClient(ev, ev === rev ? rp : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
      }
    }
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
      for (const rev of toolCallTextRecoverer.flush()) {
        const rp = parseStreamEventData(rev.data)
        for (const ev of toolInputDecoder.processEvent(rp, rev)) {
          await forwardToClient(ev, ev === rev ? rp : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
        }
      }
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

/** Handle non-streaming direct Anthropic response */
function handleDirectAnthropicNonStreamingResponse(
  c: Context,
  response: AnthropicMessageResponse,
  reqCtx: RequestContext,
  truncateResult: AnthropicAutoTruncateResult | undefined,
  anthropicPayload: MessagesPayload,
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

  // Recover upstream tool-call text downgrade → standard tool_use blocks (client-facing only).
  // Runs BEFORE restoreToolNames so synthesized wire-name tool_use gets name-restored too.
  finalResponse = recoverToolCallTextInResponse(finalResponse, {
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })

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
