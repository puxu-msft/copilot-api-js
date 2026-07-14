/**
 * Shared upstream-stream disconnect diagnostics — the SINGLE emission point + frame-signal collector
 * for the `[upstream-diagnostics] STREAM DISCONNECT` line, used by EVERY non-native-Anthropic response
 * pump: messages translate leg, Responses direct + reverse, Responses WS, Chat-Completions direct +
 * reverse, and Gemini direct + reverse. (The native Anthropic `/v1/messages` pump emits the same line
 * via its own `recordUpstreamFrame` accumulators — the structural superset of this module's ctx type.)
 *
 * Why a shared module (not per-pump inline): the diagnostic silently misreported a healthy 5-min stream
 * capped by an upstream `NGHTTP2_CANCEL` as `frames=0 / silence=<whole duration>` — because the translate
 * leg fed `logUpstreamStreamError` hardcoded empty shells, and the Responses direct/reverse/WS pumps did
 * not emit the diagnostic AT ALL (only `consola.error` + `ctx.fail`). Centralizing the frame-signal
 * collection (`createUpstreamFrameDiagnostics`) + the emit call means a new pump wires ONE primitive
 * instead of hand-rolling counters it can forget or stub — the whole "a pump under-reports its wire
 * activity" bug class is designed out (gpt-5.6-sol incident, 2026-07-14).
 *
 * Import boundary: this lives in `~/lib` (not `~/lib/upstream-diagnostics`) because it depends on
 * `~/lib/error` (`formatErrorWithCause`) and `~/lib/error` already imports `~/lib/upstream-diagnostics`
 * — folding it into that module would cycle. It is a leaf: only route pumps import it.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { SseEventRecord } from "~/lib/history/store"

import { formatErrorWithCause } from "~/lib/error"
import { classifyStreamError } from "~/lib/stream"
import { logUpstreamStreamDisconnect } from "~/lib/upstream-diagnostics"

/**
 * Honest last-frame label for the diagnostic, format-agnostic (the same collector serves CC, Responses,
 * and Anthropic upstreams). Responses frames carry `type` (`response.output_text.delta` …), CC chunks
 * carry `object` (`chat.completion.chunk`) with no `type`, Anthropic frames carry `type`; a `[DONE]`
 * terminator and an eventless keepalive comment are labelled as such rather than mislabelled. Labelling a
 * real content frame "keepalive" (a naive fallback) would re-mislead a reader into thinking no real frame
 * arrived — the exact confusion this diagnostic exists to prevent.
 */
export function upstreamFrameDiagType(rawEvent: ServerSentEventMessage): string {
  const data = rawEvent.data
  if (!data) return rawEvent.event ?? "keepalive"
  if (data === "[DONE]") return "[DONE]"
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    return (typeof parsed.type === "string" && parsed.type) || (typeof parsed.object === "string" && parsed.object) || rawEvent.event || "keepalive"
  } catch {
    // A malformed DATA-bearing frame is wire activity carrying UNPARSEABLE content — label by its SSE
    // `event:` line, else `malformed` (NOT `keepalive`: this file exists to stop real frames being mislabelled
    // as silence, and an empty-data keepalive vs a garbled-data frame are different diagnostic facts).
    return rawEvent.event ?? "malformed"
  }
}

/** Live upstream-frame signal collector for the disconnect diagnostic. */
export interface UpstreamFrameDiagnostics {
  /**
   * Observe ONE raw upstream frame (verbatim, pre-render). Counts EVERY frame handed to it — including
   * empty keepalive comments — so the diagnostic faithfully reflects wire activity (an empty ping frame is
   * still a byte on the wire, and under-counting it would re-mislead a live stream as silent). Mirrors the
   * direct Anthropic pump's `recordUpstreamFrame` (which also counts unconditionally).
   *
   * NOTE on `[DONE]`: in PRODUCTION the driver's `onUpstreamFrame` hook is gated behind `data !== "[DONE]"`
   * (driver.ts — the `[DONE]` sentinel is a gateway-injected transport terminator, excluded from the persisted
   * upstream-original track too), so a wired collector never observes `[DONE]`. `observe` still labels it
   * honestly if called directly (a pure-function property), but do NOT read the interface as "production counts
   * the terminator". The real gap-B case this closes is the EMPTY keepalive (which DOES pass the driver gate).
   */
  observe: (rawEvent: ServerSentEventMessage) => void
  /** The verbatim raw-frame track (diagnostics-only; the PERSISTED upstream-original track is the driver's). */
  readonly sseEvents: Array<SseEventRecord>
  /** Total upstream bytes observed (sum of every observed frame's `data` length, incl. empty keepalives). */
  readonly bytesIn: number
  /**
   * The epoch this collector was anchored at — the SAME base every `sseEvents[i].offsetMs` is relative to.
   * The disconnect emit MUST derive `elapsedMs` from THIS (not a separately-threaded request-start), or a
   * buffered retry that rebinds a fresh per-attempt collector would mix a whole-request elapsed with the
   * last-attempt's frames → a zero-frame final attempt re-reported as `frames=0 / silence=<whole request>`
   * (the exact gpt-5.6-sol misread, in a sub-case). Pair `startedAtMs` with `sseEvents` at the emit site.
   */
  readonly startedAtMs: number
}

/** Create a per-request (or per-buffered-attempt) upstream-frame diagnostics collector anchored at `startedAtMs`. */
export function createUpstreamFrameDiagnostics(startedAtMs: number): UpstreamFrameDiagnostics {
  const sseEvents: Array<SseEventRecord> = []
  let bytesIn = 0
  return {
    sseEvents,
    startedAtMs,
    get bytesIn() {
      return bytesIn
    },
    observe(rawEvent: ServerSentEventMessage): void {
      bytesIn += rawEvent.data?.length ?? 0
      sseEvents.push({ offsetMs: Date.now() - startedAtMs, type: upstreamFrameDiagType(rawEvent), raw: rawEvent.data ?? "" })
    },
  }
}

/**
 * Emit the `[upstream-diagnostics] STREAM DISCONNECT` line for a failed upstream stream.
 *
 * The bare error (`terminated (cause: other side closed)`) says nothing about WHY; this surfaces the
 * live-stream signals (frames / bytes / last-frame offset → `silence`, tokens) so a drop is diagnosable
 * from the log alone. Delegates formatting to `logUpstreamStreamDisconnect`.
 *
 * `ctx` takes the MINIMAL structural subset the diagnostic reads — NOT the full Anthropic `StreamPumpState`
 * / accumulator. Requiring those full shapes is what let a translate leg pass hardcoded empty shells
 * (bytesIn:0 / empty acc / []) and silently misreport; the narrow type forces every caller to supply real
 * signals (the direct pump's full structs are structural supersets). Pair with
 * {@link createUpstreamFrameDiagnostics} for `bytesIn`/`sseEvents`.
 */
export function logUpstreamStreamError(
  error: unknown,
  ctx: {
    model: string
    streamState: { streamStartMs: number; bytesIn: number; currentBlockType: string }
    acc: { inputTokens: number; outputTokens: number }
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
