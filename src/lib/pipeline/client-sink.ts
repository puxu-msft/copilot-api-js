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
 * Sampling-track: every frame written to the client — real, heartbeat, OR synthetic — is
 * sampled into the FORWARDED track, because the forwarded track (`inboundResponse.sseEvents`)
 * must faithfully record what the client actually received (richest-data-flow):
 *   - `write` (real upstream→client frame) samples the FORWARDED track (`onForwarded`).
 *   - the internal heartbeat timer's ping ALSO samples forwarded (a ping IS a
 *     proxy→client frame; it appears in `inboundResponse.sseEvents`, never the raw
 *     `sseEvents` upstream track — DESIGN.md 原则3).
 *   - `writeSynthetic` (handler-injected terminal error frame) ALSO samples forwarded — the
 *     client receives it, so it belongs in the forwarded track. (This reverses the earlier
 *     Stage-B "H3-unsampled" B0-c choice, which dropped the client-received error frame from
 *     history — a data-loss bug under richest-data-flow.) The handler MUST call
 *     `recordForwarded()` AFTER `writeSynthetic` and BEFORE `ctx.fail/complete`, since the
 *     settle snapshots `inboundResponse` synchronously (a trailing `finally` snapshot is too late).
 */

import type { SSEStreamingApi } from "hono/streaming"
import type { WSContext } from "hono/ws"

import type { SseEventRecord } from "~/lib/history"

import type { ClientFrame } from "./types"
import type { ClientSink } from "./types"

/**
 * The currently-open content block observed on the FORWARDED stream — lets a block-aware
 * keepalive provider pick a protocol-legal EMPTY delta matching the open block's type
 * (thinking→thinking_delta, text→text_delta, tool_use→input_json_delta). Such an empty delta
 * resets Claude Code's 300s no-real-content idle deadline that a bare `event: ping` does NOT
 * (a ping is not counted as a "chunk"; see exp/cc-idle-280s/REPORT.md). Generic across
 * content-block-structured SSE streams; the sink derives it from frames it ACTUALLY forwards,
 * so it is correct in both live and buffered modes (buffered → nothing forwarded → undefined).
 */
export interface OpenBlock {
  index: number
  type: string
}

/**
 * Forward-idle heartbeat config for {@link makeSseSink} (Stage B B2). The format supplies the
 * keepalive FRAME (or a provider) — the sink stays format-agnostic. `intervalSec <= 0` disables
 * it. Mirrors `startForwardedSseHeartbeat` (streaming-pump.ts) but lives in the sink so `write`
 * naturally notes the last-real-frame time. The injected frame is sampled into the forwarded track.
 */
export interface SseSinkHeartbeat {
  /** Seconds of client-forward silence before a synthetic keepalive is injected (<=0 disables). */
  intervalSec: number
  /**
   * The keepalive frame to inject on forward-idle. Either a FIXED frame (classic `event: ping`)
   * or a PROVIDER called with the current {@link OpenBlock} for block-aware keepalive (an empty
   * content delta matching the open block's type). When a provider is supplied the sink tracks
   * the open block from forwarded frames; a fixed frame does ZERO parsing (byte-identical to before).
   */
  pingFrame: ClientFrame | ((openBlock?: OpenBlock) => ClientFrame)
  /** Suppress pings once the client has disconnected. */
  clientAbortSignal?: AbortSignal
  /**
   * Buffered-pre-commit anchor injector (empty_text mode). Called by the tick when the forward
   * stream has NO open block yet: it forwards message_start + a synthetic empty-text anchor block
   * (via the sink's PUBLIC {@link ClientSink.write}, so `noteBlockState` lights openBlock={0,text})
   * + a first empty text_delta. Returns `false` when it cannot inject yet (the pre-message_start
   * window) → that tick falls back to the provider/ping frame. Registered ONLY on the buffered
   * path (the live path never sets it; a live stream always has real forwarded blocks to derive the
   * open block from). The closure itself is supplied by the driver/handler (Task 3/4).
   */
  injectAnchor?: () => Promise<boolean>
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
  /**
   * Override the forwarded record `type` derivation (default {@link frameType}). Gemini frames
   * carry no SSE `event:` line and no JSON `type` field, so the default would label them
   * "message"; the legacy Gemini handler hard-labeled every forwarded frame "generateContent".
   * A format passes a constant `() => "generateContent"` to preserve that history-track label.
   */
  forwardedType?: (frame: ClientFrame) => string
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
  const { heartbeat, onForwarded, streamStartMs = Date.now(), forwardedType } = opts
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

  const sampleForwarded = (frame: ClientFrame, synthetic?: "keepalive" | "anchor"): void => {
    onForwarded?.({
      offsetMs: Date.now() - streamStartMs,
      type: (forwardedType ?? frameType)(frame),
      raw: frame.data ?? "",
      ...(synthetic ? { synthetic } : {}),
    })
  }

  // Forward-idle (SOFT) racer state — only armed when a heartbeat is configured. It does
  // NOT touch the upstream-idle guard (transport-resident, HARD kill): the two are
  // deliberately SEPARATE racers (design §3.3 / B2 two-racer) so a heartbeat can't keep a
  // silent-upstream stream alive forever.
  const heartbeatOn = heartbeat !== undefined && heartbeat.intervalSec > 0
  // Block-aware keepalive: track the open content block ONLY when a provider pingFrame is set
  // (fixed-frame mode does zero parsing → byte-identical to before). Generic content-block state
  // machine reading JSON fields shared by content-block-structured SSE streams; no Anthropic import.
  const trackOpenBlock = heartbeatOn && typeof heartbeat.pingFrame === "function"
  let openBlock: OpenBlock | undefined
  const noteBlockState = (frame: ClientFrame): void => {
    if (!trackOpenBlock || frame.data === undefined) return
    try {
      const p = JSON.parse(frame.data) as { type?: unknown; index?: unknown; content_block?: { type?: unknown } }
      if (p.type === "content_block_start" && typeof p.index === "number" && typeof p.content_block?.type === "string") {
        openBlock = { index: p.index, type: p.content_block.type }
      } else if (p.type === "content_block_stop" && typeof p.index === "number" && openBlock?.index === p.index) {
        openBlock = undefined
      }
    } catch {
      // non-JSON frame → not a content-block boundary; leave openBlock unchanged
    }
  }
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  // One-shot guard so concurrent/re-entrant ticks can't fire a second anchor injection (which would
  // collide block indices). Reset to false when an injection reports `did===false` (pre-message_start),
  // so the NEXT idle tick retries once message_start has arrived (spec §3.3 lazy injection).
  let anchorAttempted = false

  // Real frame → sample forwarded + write. noteRealFrame BEFORE the await so a timer
  // firing mid-write sees the fresh ts and skips a redundant ping.
  const write = (frame: ClientFrame): Promise<void> => {
    lastRealMs = Date.now()
    noteBlockState(frame) // update open-block state from real forwarded frames (provider mode only)
    sampleForwarded(frame)
    return writeSse(frame)
  }

  // Handler-injected synthetic frame (the terminal error frame): write to the wire AND
  // sample forwarded — a proxy-synthesized terminal error IS a proxy→client frame the
  // client actually receives, so it must appear in `inboundResponse.sseEvents` (richest-
  // data-flow). Sampled enqueue-first, identical to `write`/ping ("recorded == attempted-
  // to-send"). NOTE: the handler must `recordForwarded()` AFTER this call and BEFORE
  // `ctx.fail/complete` — the settle snapshots `inboundResponse` synchronously, so a
  // post-settle snapshot (e.g. a trailing `finally`) would miss this frame.
  const writeSynthetic = (frame: ClientFrame): Promise<void> => {
    sampleForwarded(frame)
    return writeSse(frame)
  }

  // A proxy-synthesized keepalive the HANDLER injects out-of-band (the cold-start commit's immediate
  // first ping). Sampled into the forwarded track with a `synthetic:"keepalive"` marker so it's never
  // mistaken for real content (the internal heartbeat timer marks its own pings the same way).
  const writeKeepalive = (frame: ClientFrame): Promise<void> => {
    sampleForwarded(frame, "keepalive")
    return writeSse(frame)
  }

  // A proxy-synthesized buffered-anchor STRUCTURAL frame (the empty-text anchor's content_block_start@0
  // / content_block_stop@0 the driver injects during a pre-commit stall). Unlike writeKeepalive it MUST
  // update the open-block state (noteBlockState) — lighting openBlock={0,text} on the start so the next
  // heartbeat tick picks a block-aware empty text_delta, and clearing it on the stop — exactly as the
  // real-frame `write` does; it just marks the forwarded record `synthetic:"anchor"` so history/UI/logs
  // never mistake the injected structural frame for a real upstream content block (richest-data-flow).
  // The anchor's OWN empty text_delta is written via writeKeepalive (it is a heartbeat, not structure).
  const writeAnchor = (frame: ClientFrame): Promise<void> => {
    lastRealMs = Date.now()
    noteBlockState(frame)
    sampleForwarded(frame, "anchor")
    return writeSse(frame)
  }

  // close stops the heartbeat timer (no-op when none) — runResponseSink's `finally`
  // MUST call it on every exit so a self-rescheduling timer can't leak.
  const close = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
  }

  // freezeHeartbeat stops the heartbeat timer WITHOUT closing the sink — `write` stays fully
  // usable (unlike close(), which sets `stopped` and refuses future ticks). The buffered anchor
  // commit / terminal flush calls this BEFORE its `for (frame of buffer) await write(frame)` loop
  // so a timer firing mid-flush can't inject a second anchor and collide block indices
  // (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.3 C1). Idempotent; a no-op on the
  // heartbeat-off path (timer is always undefined).
  const freezeHeartbeat = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  if (!heartbeatOn) {
    return { write, writeSynthetic, writeKeepalive, writeAnchor, close, freezeHeartbeat }
  }

  const intervalMs = heartbeat.intervalSec * 1000
  // Emit ONE keepalive frame (fixed ping, or provider-chosen block-aware empty delta) into the
  // forwarded track + wire. Does NOT reschedule the timer (each caller reschedules as appropriate).
  const emitKeepalive = (): void => {
    // Synthetic keepalive — a FIXED ping frame, or (provider mode) a block-aware empty delta chosen
    // from the current open block. Sampled into the forwarded track (a keepalive IS a proxy→client
    // frame), shares the chain (no byte-interleave). Errors swallowed: the next real write hits the
    // same closed stream and routes through the driver's outcome path.
    const frame = typeof heartbeat.pingFrame === "function" ? heartbeat.pingFrame(openBlock) : heartbeat.pingFrame
    sampleForwarded(frame, "keepalive")
    void writeSse(frame).catch(() => undefined)
    lastRealMs = Date.now()
  }
  const tick = (): void => {
    if (stopped || heartbeat.clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      // Buffered empty_text anchor (§3.3): the forward stream has NO open block yet → light one by
      // asking the driver-supplied closure to forward message_start + the empty-text anchor block
      // (through the PUBLIC write, so noteBlockState updates openBlock). Runs BEFORE the provider
      // frame is chosen — a provider called with openBlock===undefined would only yield a bare ping.
      if (heartbeat.injectAnchor && openBlock === undefined && !anchorAttempted) {
        anchorAttempted = true
        void heartbeat
          .injectAnchor()
          .then((did) => {
            // false = pre-message_start window → this tick falls back to a ping; re-arm for the next.
            if (!did) {
              anchorAttempted = false
              emitKeepalive()
            }
          })
          .catch(() => {
            // injectAnchor rejects only when a sink.write rejected = the client is already gone.
            // Re-arm and still emit one keepalive so the "every idle tick emits exactly one frame"
            // invariant holds (the keepalive hits the same closed stream and routes through the
            // driver's outcome path); without this the tick would silently waste one interval.
            anchorAttempted = false
            emitKeepalive()
          })
        lastRealMs = Date.now()
        timer = setTimeout(tick, intervalMs)
        return
      }
      emitKeepalive()
      timer = setTimeout(tick, intervalMs)
    } else {
      timer = setTimeout(tick, intervalMs - elapsed)
    }
  }
  timer = setTimeout(tick, intervalMs)
  // unref so a leaked timer can never hold the event loop / block graceful shutdown.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return { write, writeSynthetic, writeKeepalive, writeAnchor, close, freezeHeartbeat }
}

/** {@link makeWsSink} options — forwarded-track sampling (optional). */
export interface WsSinkOptions {
  /**
   * Forwarded-track sampler invoked per written frame (→ history `inboundResponse.sseEvents`).
   * The record shape (offsetMs / parsed-type / raw bytes) mirrors the legacy `forwardWsFrame`
   * push (`{type: event.type, raw: forwardData}`; `frameType` yields the parsed JSON `type`).
   */
  onForwarded?: (record: SseEventRecord) => void
  /** Stream-start reference for the forwarded record `offsetMs` (defaults to now). */
  streamStartMs?: number
}

/** WS sink — writes JSON frame strings through a Hono `WSContext` (the Responses WS path). */
export function makeWsSink(ws: WSContext, opts: WsSinkOptions = {}): ClientSink {
  const { onForwarded, streamStartMs = Date.now() } = opts
  const enqueue = makeSerializer()
  // Sample the forwarded track synchronously at call time (before the enqueued send), then
  // write. WS frames carry only `data` (no SSE event/id/retry line), matching legacy `ws.send`.
  const send = (frame: ClientFrame): Promise<void> => {
    onForwarded?.({ offsetMs: Date.now() - streamStartMs, type: frameType(frame), raw: frame.data ?? "" })
    return enqueue(() => {
      ws.send(frame.data ?? "")
    })
  }
  return {
    write: send,
    // A handler-synthesized terminal error frame IS a proxy→client frame (the WS analog of the
    // HTTP `writeSynthetic`) — sample + send it identically so it lands in `inboundResponse.sseEvents`.
    // The handler must `recordForwarded()` after this and before `ctx.fail` (see makeSseSink).
    writeSynthetic: send,
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
