/**
 * v4 pipeline — ClientSink factories (Stage B B1/B2 + Anthropic cut-over, design §3.3).
 *
 * The driver's owns-the-sink write-out port + its concrete adapters. The driver
 * consumes the abstract {@link ClientSink}; these factories are the ONLY place that
 * knows the transport (Hono SSE / WS) — and they touch it through type-only imports
 * + method calls, so `lib/pipeline` keeps no runtime Hono dependency.
 *
 * Every sink serializes all writes through ONE Promise chain (the existing
 * `heartbeat.writeSerialized` pattern, lifted here): real frames + synthetic
 * heartbeats + error frames can never byte-interleave. A write that REJECTS (client
 * disconnect mid-write) propagates to the awaiting driver loop (→ a non-`complete`
 * outcome) while the chain itself stays alive (the stored chain swallows so the next
 * write still runs) — mirroring streaming-pump.ts:362-367 so the disconnect is never
 * silently swallowed into a `complete`.
 *
 * Sampling-track asymmetry (the cut-over piece, design §3.3 audit):
 *   - `write` (real upstream→client frame) samples the FORWARDED track (`onForwarded`).
 *   - the internal heartbeat timer's ping ALSO samples forwarded (a ping IS a
 *     proxy→client frame; it appears in `inboundResponse.sseEvents`, never the raw
 *     `sseEvents` upstream track — DESIGN.md 原则3).
 *   - `writeSynthetic` (handler-injected, e.g. the H3 synthesized error frame) writes
 *     to the WIRE but does NOT sample — so a handler-synthesized terminal error never
 *     enters the forwarded track (the H2-sampled / H3-unsampled asymmetry the B0-c
 *     golden locks). This is red-line-3 option "writeSynthetic 不推 onForwarded".
 */

import type { SSEStreamingApi } from "hono/streaming"
import type { WSContext } from "hono/ws"

import type { SseEventRecord } from "~/lib/history"

import type { ClientFrame } from "./types"
import type { ClientSink } from "./types"

/**
 * Forward-idle heartbeat config for {@link makeSseSink} (Stage B B2). The format
 * supplies the ping FRAME (Anthropic `event: ping` / `{type:"ping"}`) — the sink stays
 * format-agnostic. `intervalSec <= 0` disables it. Mirrors `startForwardedSseHeartbeat`
 * (streaming-pump.ts) but lives in the sink so `write` naturally notes the last-real-frame
 * time. The injected ping is sampled into the forwarded track (the timer below).
 */
export interface SseSinkHeartbeat {
  /** Seconds of client-forward silence before a synthetic ping is injected (<=0 disables). */
  intervalSec: number
  /** The already-terminal-form ping frame to inject (format-specific). */
  pingFrame: ClientFrame
  /** Suppress pings once the client has disconnected. */
  clientAbortSignal?: AbortSignal
}

/** {@link makeSseSink} options — heartbeat (optional) + forwarded-track sampling (optional). */
export interface SseSinkOptions {
  /** Forward-idle keepalive (omitted / `intervalSec<=0` → no timer). */
  heartbeat?: SseSinkHeartbeat
  /**
   * Forwarded-track sampler: invoked per real frame (`write`) AND per injected ping
   * (the heartbeat timer), NEVER per `writeSynthetic`. The handler pushes the record
   * into `forwardedSseEvents` (→ history `inboundResponse.sseEvents`). The record
   * shape (offsetMs / parsed-type / raw bytes) mirrors the legacy `forwardClientFrame`.
   */
  onForwarded?: (record: SseEventRecord) => void
  /** Stream-start reference for the forwarded record `offsetMs` (defaults to now). */
  streamStartMs?: number
}

/**
 * A single-Promise-chain serializer. Returns an `enqueue` that runs `fn` after all
 * prior writes complete and resolves/rejects with `fn`'s result — but keeps the
 * internal chain alive across a rejection (so one failed write doesn't wedge the
 * sink) while still surfacing that rejection to the caller.
 */
function makeSerializer(): (fn: () => void | Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (fn) => {
    const next = chain.then(fn)
    // Stored chain swallows so a rejected write doesn't poison subsequent writes;
    // the RETURNED `next` keeps the rejection so the driver loop sees the disconnect.
    chain = next.catch(() => undefined)
    return next
  }
}

/**
 * Derive the forwarded-record `type`: the parsed JSON `type`, falling back to the SSE
 * `event:` name, then — for a data-bearing frame with neither — "message" (a content
 * chunk), and "keepalive" only for an empty frame. The fallback tail mirrors the driver's
 * upstream-track derivation (driver.ts loop-top: `frame.event ?? (frame.data ? "message" :
 * "keepalive")`) so the forwarded + upstream tracks label frames by the SAME rule. Anthropic
 * frames carry a parsed `type` (and the ping an `event`) so they never reach the tail; CC
 * chunks (no `type`, no `event` line) read "message", matching the legacy CC `frame.event ??
 * "message"` push for every frame CC actually forwards (an event-less EMPTY frame — which
 * compliant OpenAI streams don't emit — reads "keepalive" here vs the legacy unconditional
 * "message", the only divergence, deliberately chosen for upstream-track consistency). Kept
 * format-agnostic (plain `JSON.parse`, no Anthropic import).
 */
function frameType(frame: ClientFrame): string {
  if (frame.data) {
    try {
      const parsed = JSON.parse(frame.data) as { type?: unknown }
      if (typeof parsed.type === "string") return parsed.type
    } catch {
      // not JSON → fall through to the event/message/keepalive label
    }
  }
  return frame.event ?? (frame.data ? "message" : "keepalive")
}

/** SSE sink — writes through Hono's `streamSSE` API (the Anthropic/CC/Responses/Gemini HTTP path). */
export function makeSseSink(stream: SSEStreamingApi, opts: SseSinkOptions = {}): ClientSink {
  const { heartbeat, onForwarded, streamStartMs = Date.now() } = opts
  const enqueue = makeSerializer()

  // Bare SSE write. Forwards the full SSE framing (event/data/id/retry) — `id`/`retry`
  // are part of the wire (the upstream may emit `id:`/`retry:` lines), so dropping them
  // would silently narrow the bypass-direct passthrough. Byte-equivalent to the legacy
  // forwardClientFrame (streaming-pump.ts): `id` stringified, undefined keys omitted.
  const writeSse = (frame: ClientFrame): Promise<void> =>
    enqueue(() =>
      stream.writeSSE({
        data: frame.data ?? "",
        ...(frame.event !== undefined && { event: frame.event }),
        ...(frame.id !== undefined && { id: String(frame.id) }),
        ...(frame.retry !== undefined && { retry: frame.retry }),
      }),
    )

  const sampleForwarded = (frame: ClientFrame): void => {
    onForwarded?.({ offsetMs: Date.now() - streamStartMs, type: frameType(frame), raw: frame.data ?? "" })
  }

  // Forward-idle (SOFT) racer state — only armed when a heartbeat is configured. It does
  // NOT touch the upstream-idle guard (transport-resident, HARD kill): the two are
  // deliberately SEPARATE racers (design §3.3 / B2 two-racer) so a heartbeat can't keep a
  // silent-upstream stream alive forever.
  const heartbeatOn = heartbeat !== undefined && heartbeat.intervalSec > 0
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  // Real frame → sample forwarded + write. noteRealFrame BEFORE the await so a timer
  // firing mid-write sees the fresh ts and skips a redundant ping.
  const write = (frame: ClientFrame): Promise<void> => {
    lastRealMs = Date.now()
    sampleForwarded(frame)
    return writeSse(frame)
  }

  // Handler-injected synthetic frame (the H3 error frame): write to the wire, NEVER
  // sample forwarded — keeps the H2-sampled/H3-unsampled asymmetry (B0-c).
  const writeSynthetic = (frame: ClientFrame): Promise<void> => writeSse(frame)

  // close stops the heartbeat timer (no-op when none) — runResponseSink's `finally`
  // MUST call it on every exit so a self-rescheduling timer can't leak.
  const close = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
  }

  if (!heartbeatOn) {
    return { write, writeSynthetic, close }
  }

  const intervalMs = heartbeat.intervalSec * 1000
  const tick = (): void => {
    if (stopped || heartbeat.clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      // Synthetic ping — sampled into the forwarded track (a ping IS a proxy→client
      // frame), shares the chain (no byte-interleave). Errors swallowed: the next real
      // write hits the same closed stream and routes through the driver's outcome path.
      sampleForwarded(heartbeat.pingFrame)
      void writeSse(heartbeat.pingFrame).catch(() => undefined)
      lastRealMs = Date.now()
      timer = setTimeout(tick, intervalMs)
    } else {
      timer = setTimeout(tick, intervalMs - elapsed)
    }
  }
  timer = setTimeout(tick, intervalMs)
  // unref so a leaked timer can never hold the event loop / block graceful shutdown.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return { write, writeSynthetic, close }
}

/** WS sink — writes JSON frame strings through a Hono `WSContext` (the Responses WS path). */
export function makeWsSink(ws: WSContext): ClientSink {
  const enqueue = makeSerializer()
  return {
    write: (frame) =>
      enqueue(() => {
        ws.send(frame.data ?? "")
      }),
  }
}

/**
 * In-memory sink for tests — collects the written frames in order. The returned
 * `frames` array is the equivalence oracle (its sequence must match the generator
 * `runResponse` yield sequence). `reject` (optional) makes the Nth write reject, to
 * fault-inject a client-disconnect-mid-write (the outcome must then be non-`complete`).
 */
export function makeArraySink(opts: { rejectAtFrame?: number } = {}): { sink: ClientSink; frames: Array<ClientFrame> } {
  const frames: Array<ClientFrame> = []
  const enqueue = makeSerializer()
  let writeIndex = 0
  return {
    frames,
    sink: {
      write: (frame) =>
        enqueue(() => {
          const idx = writeIndex++
          if (opts.rejectAtFrame !== undefined && idx === opts.rejectAtFrame) {
            throw new Error(`client disconnected mid-write (injected at write ${opts.rejectAtFrame})`)
          }
          frames.push(frame)
        }),
    },
  }
}
