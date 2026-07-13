/**
 * Anthropic streaming pump — shared primitives extracted from handler.ts.
 *
 * These are the SSE forwarding / heartbeat / per-event processing primitives
 * used by the legacy `handler.ts` and (in the v4 rearchitecture) the future
 * `handler-v4.ts`. Pure code move from handler.ts — no logic changes.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type { StreamEvent } from "~/types/api/anthropic"

import { logServerToolBlock } from "~/lib/anthropic/server-tool-filter"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { formatErrorWithCause } from "~/lib/error"
import { classifyStreamError } from "~/lib/stream"
import { logUpstreamStreamDisconnect } from "~/lib/upstream-diagnostics"

/**
 * Map a streaming error to its Anthropic SSE `error.type`. Shutdown → retryable overloaded_error.
 *
 * G-3: the mapping logic now lives in `error-shaping.ts` (`classifyStreamErrorType`, the single home
 * for error→Anthropic-wire shaping). This re-export keeps the original name/signature so the two
 * real call sites — `handler-v4.ts:1193` (H3 branch) and `handler-v4.ts:1452` (translate-leg pump) —
 * stay byte-for-byte unchanged; only the implementation moved. `codec.ts:619` merely mentions the
 * name in a comment (not a call site).
 */
export { classifyStreamErrorType as anthropicStreamErrorType } from "~/lib/anthropic/error-shaping"

/**
 * Extract live-stream signals and emit a detailed upstream-disconnect log.
 *
 * Pulls the diagnostic signals out of the handler-internal stream state and
 * delegates formatting/emission to `logUpstreamStreamDisconnect`. The `silence`
 * it surfaces (gap between the last upstream frame and the disconnect) is the
 * smoking gun for "died during a silent thinking stall".
 */
export function logUpstreamStreamError(
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

/** Mutable counters/state threaded through the streaming pump. */
export interface StreamPumpState {
  streamStartMs: number
  bytesIn: number
  eventsIn: number
  currentBlockType: string
  firstEventLogged: boolean
  recoverFeatureLogged: boolean
}

/** Inputs for {@link recordUpstreamFrame} — the upstream-side (raw) recording. */
export interface RecordUpstreamFrameArgs {
  rawEvent: ServerSentEventMessage
  parsed: StreamEvent | undefined
  streamState: StreamPumpState
  sseEvents: Array<SseEventRecord>
  reqCtx: RequestContext
  checkRepetition: (text: string) => void
}

/**
 * Upstream-side recording for ONE raw upstream frame: counters, the verbatim
 * `sseEvents` record, block-boundary debug + server-tool logging, the stream-progress
 * publish, and the repetition check. Operates on the UPSTREAM-ORIGINAL frame — in the
 * v4 driver path the handler runs this via `driver.runResponse`'s `onUpstreamFrame`
 * hook (BEFORE the S5 rewrite chain), so accumulate / progress / diagnostics stay on
 * raw frames even though the driver yields the rewritten ones (RFC §4.A1).
 */
export function recordUpstreamFrame(args: RecordUpstreamFrameArgs): void {
  const { rawEvent, parsed, streamState, sseEvents, reqCtx, checkRepetition } = args

  const dataLen = rawEvent.data?.length ?? 0
  streamState.bytesIn += dataLen
  streamState.eventsIn++

  // Faithfully record every raw upstream event, including `ping` keepalives —
  // their timing reveals upstream idle gaps. `raw` stores the verbatim upstream
  // `data:` bytes (no parse round-trip); `type` is derived for indexing. Required by
  // 原则3 (后端存储必须完整,不主动丢弃任何可观测原始数据).
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

  // Publish streaming progress to the observability bus (ConsoleSink footer reads
  // bytesIn/eventsIn/blockType from `request.stream_progress`).
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
}
