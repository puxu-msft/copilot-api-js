/**
 * Anthropic streaming pump — shared primitives extracted from handler.ts.
 *
 * These are the SSE forwarding / heartbeat / per-event processing primitives
 * used by the legacy `handler.ts` and (in the v4 rearchitecture) the future
 * `handler-v4.ts`. Pure code move from handler.ts — no logic changes.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"

import type { ToolInputStreamDecoder } from "~/lib/anthropic/decode-tool-input"
import type { ToolCallTextRecoverer } from "~/lib/anthropic/recover-tool-call"
import type { RequestContext } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type { OpenBlock } from "~/lib/pipeline/client-sink"
import type { ClientFrame } from "~/lib/pipeline/types"
import type { StreamEvent } from "~/types/api/anthropic"

import { ANTHROPIC_PING } from "~/lib/anthropic/keepalive-frame"
import {
  //
  createServerToolBlockFilter,
  logServerToolBlock,
} from "~/lib/anthropic/server-tool-filter"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { applyThinkingSignatureCompat } from "~/lib/anthropic/thinking-signature-compat"
import { formatErrorWithCause } from "~/lib/error"
import { state } from "~/lib/state"
import { classifyStreamError } from "~/lib/stream"
import { logUpstreamStreamDisconnect } from "~/lib/upstream-diagnostics"

/** Map a streaming error to its Anthropic SSE `error.type`. Shutdown → retryable overloaded_error. */
export function anthropicStreamErrorType(error: unknown): string {
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

export interface ProcessOneStreamEventArgs {
  rawEvent: ServerSentEventMessage
  parsed: StreamEvent | undefined
  streamState: StreamPumpState
  sseEvents: Array<SseEventRecord>
  forwardedSseEvents: Array<SseEventRecord>
  reqCtx: RequestContext
  checkRepetition: (text: string) => void
  serverToolFilter: ReturnType<typeof createServerToolBlockFilter>
  toolInputDecoder: ToolInputStreamDecoder
  toolCallTextRecoverer: ToolCallTextRecoverer
  heartbeat: ForwardedSseHeartbeat
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
 * raw frames even though the driver yields the rewritten ones (RFC §4.A1). The legacy
 * `processOneStreamEvent` (web_search direct path) calls it too, then runs its own
 * recover/decode/filter nesting + forward.
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

/**
 * Process a single upstream SSE event: update counters, record debug info,
 * filter server-tool blocks, and forward to the client. Mutates `streamState`,
 * `sseEvents`, `forwardedSseEvents`, and writes to `stream`.
 */
export async function processOneStreamEvent(args: ProcessOneStreamEventArgs): Promise<void> {
  const {
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
  } = args

  // Raw-side recording (sseEvents, debug, progress, repetition, server-tool logging) —
  // shared with the v4 driver path's `onUpstreamFrame` hook (recordUpstreamFrame).
  recordUpstreamFrame({ rawEvent, parsed, streamState, sseEvents, reqCtx, checkRepetition })

  // Tool-call text recovery (text→tool_use) is the OUTERMOST response transform: it
  // sees every upstream event (incl. message_start/message_delta) to keep its state,
  // and emits 0/1/many frames (buffering during CANDIDATE, synthesizing on COMMIT).
  // Each emitted frame then runs the existing thinking-signature-compat shim and the
  // tool-input decoder, before forwardToClient (serverToolFilter restores synthesized
  // wire-name tool_use names + remaps indices). Recoverer is a no-op when disabled.
  for (const recovered of toolCallTextRecoverer.processEvent(parsed, rawEvent)) {
    const recoveredParsed = recovered === rawEvent ? parsed : parseStreamEventData(recovered.data)

    // Synthesized tool_use content_block_start (fresh frame, not pass-through) signals
    // a recovery happened — record a persistent, auditable feature once per response.
    if (
      !streamState.recoverFeatureLogged
      && recovered !== rawEvent
      && recoveredParsed?.type === "content_block_start"
      && (recoveredParsed.content_block as { type?: string }).type === "tool_use"
    ) {
      streamState.recoverFeatureLogged = true
      reqCtx.recordFeature("tool-call-recovered")
      consola.info("[RECOVER] rebuilt tool_use from downgraded upstream text")
    }

    // thinking-signature compat shim (per recovered frame; bypasses decoder like before)
    if (recoveredParsed) {
      const compatFrames = applyThinkingSignatureCompat(recoveredParsed, state.thinkingSignatureCompat)
      if (compatFrames) {
        for (const repl of compatFrames) {
          const replRaw: ServerSentEventMessage = { ...recovered, data: JSON.stringify(repl) }
          await forwardToClient(replRaw, repl, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
        }
        continue
      }
    }

    // tool-input decoder (buffers selected tool_use input; no-op on recoverer's
    // already-typed synthesized tool_use via reference-equality)
    for (const ev of toolInputDecoder.processEvent(recoveredParsed, recovered)) {
      await forwardToClient(ev, ev === recovered ? recoveredParsed : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
    }
  }
}

/** Best-effort parse of an SSE data payload into a StreamEvent (undefined on failure / keepalive). */
export function parseStreamEventData(data: string | undefined): StreamEvent | undefined {
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
export async function forwardToClient(
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

/**
 * Forward one ALREADY-REWRITTEN client frame (the v4 driver path): sample it into
 * `forwardedSseEvents` (the proxy→client record) + write it via the heartbeat-serialized
 * writer. Unlike {@link forwardToClient} this does NO server-tool filtering / index
 * remap — the driver's S5 chain already applied those, so the frame `ev` is the final
 * client bytes (suppressed frames never reach here: `passThrough` doesn't yield them).
 */
export async function forwardClientFrame(
  ev: ServerSentEventMessage,
  forwardedSseEvents: Array<SseEventRecord>,
  streamStartMs: number,
  heartbeat: ForwardedSseHeartbeat,
): Promise<void> {
  const parsed = parseStreamEventData(ev.data)
  forwardedSseEvents.push({
    offsetMs: Date.now() - streamStartMs,
    type: parsed?.type ?? ev.event ?? "keepalive",
    raw: ev.data ?? "",
  })
  heartbeat.noteRealFrame()
  await heartbeat.writeSerialized({
    data: ev.data ?? "",
    event: ev.event,
    id: ev.id !== undefined ? String(ev.id) : undefined,
    retry: ev.retry,
  })
}

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
  /**
   * Block-aware keepalive: a provider called with the current FORWARDED open block, or a fixed
   * frame. Omitted → the classic bare ping. The open block is derived from frames written through
   * `writeSerialized` (forwarded-side, so index/type match what the client actually received after
   * server-tool filtering / decode).
   */
  keepaliveFrame?: ClientFrame | ((openBlock?: OpenBlock) => ClientFrame)
}

/** Derive the forwarded-track `type` from a keepalive frame (parsed JSON type → event → keepalive). */
function deriveForwardedType(frame: ClientFrame): string {
  if (frame.data) {
    try {
      const t = (JSON.parse(frame.data) as { type?: unknown }).type
      if (typeof t === "string") return t
    } catch {
      // non-JSON → fall through
    }
  }
  return frame.event ?? "keepalive"
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
  const { intervalSec, stream, forwardedSseEvents, streamState, clientAbortSignal, keepaliveFrame } = opts
  // Forwarded-side open-block tracking for a block-aware keepalive (provider mode only). Derived
  // from frames written through writeSerialized — what the client ACTUALLY receives (post server-
  // tool-filter / decode), so index/type are correct. A keepalive delta is not a block boundary,
  // so it never mutates this.
  const trackOpenBlock = typeof keepaliveFrame === "function"
  let openBlock: OpenBlock | undefined
  const noteBlockFromWrite = (data: string | Promise<string> | undefined): void => {
    if (!trackOpenBlock || typeof data !== "string") return
    try {
      const p = JSON.parse(data) as { type?: unknown; index?: unknown; content_block?: { type?: unknown } }
      if (p.type === "content_block_start" && typeof p.index === "number" && typeof p.content_block?.type === "string") {
        openBlock = { index: p.index, type: p.content_block.type }
      } else if (p.type === "content_block_stop" && typeof p.index === "number" && openBlock?.index === p.index) {
        openBlock = undefined
      }
    } catch {
      // non-JSON → not a content-block boundary
    }
  }
  let writeChain: Promise<void> = Promise.resolve()
  const writeSerialized = (msg: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> => {
    noteBlockFromWrite(msg.data)
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
      // Inject one keepalive — a block-aware empty content delta (provider mode) or a bare
      // `event: ping`. An empty delta resets Claude Code's 300s no-real-content idle deadline that
      // a ping does NOT (exp/cc-idle-280s); a ping still keeps the TCP connection alive on byte
      // arrival. Recorded ONLY in forwardedSseEvents (原则3, never the raw upstream track).
      const frame = typeof keepaliveFrame === "function" ? keepaliveFrame(openBlock) : (keepaliveFrame ?? ANTHROPIC_PING)
      const data = frame.data ?? ""
      forwardedSseEvents.push({
        offsetMs: Date.now() - streamState.streamStartMs,
        type: deriveForwardedType(frame),
        raw: data,
      })
      // Serialized write — the heartbeat may race the main pump; the shared chain guarantees
      // byte-level non-interleaving. Errors (closed stream) are swallowed: the main pump's next
      // write hits the same error and routes through the existing settle path.
      void writeSerialized({ event: frame.event, data }).catch(() => undefined)
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
