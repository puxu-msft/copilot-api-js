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

import { readSyntheticKind } from "~/lib/pipeline/frame-origin"

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
 * it. Lives in the sink so `write` naturally notes the last-real-frame time. The injected frame
 * is sampled into the forwarded track.
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
   * shape (offsetMs / parsed-type / raw bytes) mirrors the legacy forwarded-record shape (streaming-pump.ts `forwardClientFrame`, removed with the web_search retirement).
   */
  onForwarded?: (record: SseEventRecord) => void
  /** History V3 arena hook, invoked at the same unique client-wire sampling point. */
  onGenerationFrame?: (frame: ClientFrame, record: SseEventRecord, syntheticKind?: SseEventRecord["synthetic"]) => void
  /** Stream-start reference for the forwarded record `offsetMs` (defaults to now). */
  streamStartMs?: number
  /**
   * Override the forwarded record `type` derivation (default {@link frameType}). Gemini frames
   * carry no SSE `event:` line and no JSON `type` field, so the default would label them
   * "message"; the legacy Gemini handler hard-labeled every forwarded frame "generateContent".
   * A format passes a constant `() => "generateContent"` to preserve that history-track label.
   */
  forwardedType?: (frame: ClientFrame) => string
  /**
   * 首包埋点（spec 2026-07-14 §3.2）：格式无关的「真实内容帧」谓词 + 首次命中回调。
   * sink 保持格式无关——handler 绑定 `isClientContentFrame(frame, clientFormat)` 与
   * `() => ctx.setClientTimingEpoch("firstReal", Date.now())`。仅在**非-synthetic** 帧上判、只触发一次。
   */
  isRealContentFrame?: (frame: ClientFrame) => boolean
  onFirstRealContent?: () => void
  /** Delivery-boundary callback; invoked once by `sink.finalize()` after all terminal writes. */
  onDeliveryFinalized?: () => void
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
  const {
    heartbeat,
    onForwarded,
    onGenerationFrame,
    streamStartMs = Date.now(),
    forwardedType,
    isRealContentFrame,
    onFirstRealContent,
    onDeliveryFinalized,
  } = opts
  const enqueue = makeSerializer()
  // 首包埋点（spec 2026-07-14 §3.2）：客户端首个真实内容帧只捕获一次。
  let firstRealFired = false

  // Bare SSE write. Forwards the full SSE framing (event/data/id/retry) — `id`/`retry`
  // are part of the wire (the upstream may emit `id:`/`retry:` lines), so dropping them
  // would silently narrow the bypass-direct passthrough. Byte-equivalent to the legacy
  // (legacy forwardClientFrame semantics, retired): `id` stringified, undefined keys omitted.
  const writeSse = (frame: ClientFrame): Promise<void> =>
    enqueue(() =>
      stream.writeSSE({
        data: frame.data ?? "",
        ...(frame.event !== undefined && { event: frame.event }),
        ...(frame.id !== undefined && { id: String(frame.id) }),
        ...(frame.retry !== undefined && { retry: frame.retry }),
      }),
    )

  const sampleForwarded = (
    frame: ClientFrame,
    synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq",
    generationSynthetic: SseEventRecord["synthetic"] = synthetic,
  ): void => {
    const record: SseEventRecord = {
      offsetMs: Date.now() - streamStartMs,
      type: (forwardedType ?? frameType)(frame),
      raw: frame.data ?? "",
      ...(synthetic ? { synthetic } : {}),
    }
    onForwarded?.(record)
    onGenerationFrame?.(frame, record, generationSynthetic)
    // 首包埋点：首个非-synthetic 真实内容帧 → ctx firstReal（handler 绑定谓词/回调）。
    if (!synthetic && !firstRealFired && isRealContentFrame?.(frame)) {
      firstRealFired = true
      onFirstRealContent?.()
    }
  }

  // Forward-idle (SOFT) racer state — only armed when a heartbeat is configured. It does
  // NOT touch the upstream-idle guard (transport-resident, HARD kill): the two are
  // deliberately SEPARATE racers (design §3.3 / B2 two-racer) so a heartbeat can't keep a
  // silent-upstream stream alive forever.
  const heartbeatOn = heartbeat !== undefined && heartbeat.intervalSec > 0
  // Block-aware keepalive: track the open content block when a provider pingFrame is set (block-aware
  // mode itself needs the stack), OR when an `injectAnchor` is configured (any anchor mode needs
  // `everOpenedRealBlock` below, even fixed-frame `enveloped_ping` which never touches the stack itself —
  // see docs/todo/deferred-backlog.md "enveloped_ping 模式的 everOpenedRealBlock 守卫零防护"). Purely
  // additive: the `typeof === "function"` branch (empty_text) is unchanged, so its behavior stays
  // byte-identical; this only newly enables tracking for enveloped_ping. Generic content-block state
  // machine reading JSON fields shared by content-block-structured SSE streams; no Anthropic import.
  const trackOpenBlock = heartbeatOn && (typeof heartbeat.pingFrame === "function" || heartbeat.injectAnchor !== undefined)
  // Open content blocks as a STACK, not a single slot (C1). An anchor@0 injected in buffered pre-commit
  // stays OPEN at the BOTTOM of the stack for the whole stream; every real block flushes at index+1 ABOVE
  // it (push on content_block_start, pop on content_block_stop). The keepalive rides the TOP (`at(-1)`):
  // while a real block is open the tick continues THAT block; once the real block closes the stack falls
  // back to the still-open anchor → the inter-block tick emits an empty `text_delta@0` (real content that
  // resets Claude Code's 300s deadline) instead of a BARE ping (a single slot was overwritten by the real
  // block's start@+1, then cleared by its stop@+1 → undefined → bare ping → 300s disconnect). For a single
  // block (no anchor beneath) the stack depth is ≤1, so this is byte-for-byte the old single-slot behavior.
  let openBlockStack: Array<OpenBlock> = []
  const currentOpenBlock = (): OpenBlock | undefined => openBlockStack.at(-1)
  // Defect (a) guard (spec §4.3, backlog "anchor 注入器可在真实块之间二次触发"): latches true the first time a
  // content block is opened on the forwarded stream. The anchor injector fires ONLY before the FIRST real block
  // (`openBlockStack.length === 0 && !anchorAttempted && !everOpenedRealBlock`). Without it, a FAST first block
  // (opened+closed before any idle tick → the anchor was NEVER injected, `anchorAttempted` still false) leaves
  // an EMPTY stack, so a LATER inter-block idle re-triggered `injectAnchor` — forwarding a DUPLICATE message_start
  // and a colliding synthetic `content_block_start@0` over the already-used real index 0. This flag makes the
  // gate "no real block has EVER opened", not merely "no block open right now". After a SUCCESSFUL anchor
  // injection `anchorAttempted` stays latched (only reset when an injection reports `did===false`, which opens no
  // block), so this flag only ever gates the FIRST injection attempt — where only a real block could have set it;
  // the anchor's own `start@0` (written after this gate passes) setting it too is therefore harmless.
  let everOpenedRealBlock = false
  const noteBlockState = (frame: ClientFrame): void => {
    if (!trackOpenBlock || frame.data === undefined) return
    try {
      const p = JSON.parse(frame.data) as { type?: unknown; index?: unknown; content_block?: { type?: unknown } }
      if (p.type === "content_block_start" && typeof p.index === "number" && typeof p.content_block?.type === "string") {
        openBlockStack.push({ index: p.index, type: p.content_block.type })
        everOpenedRealBlock = true
      } else if (p.type === "content_block_stop" && typeof p.index === "number") {
        openBlockStack = openBlockStack.filter((b) => b.index !== p.index) // pop the closed block (by index; may be below the top for out-of-order stops)
      }
    } catch {
      // non-JSON frame → not a content-block boundary; leave the stack unchanged
    }
  }
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  // Recoverable per-block flush guard (spec 2026-07-11-block-level-buffered-retry §4.4). Distinct from
  // freezeHeartbeat (PERMANENT — clears the timer, never resumes): `suspendHeartbeat` only STOPS the tick
  // from INJECTING (the tick top-guards on this flag and early-returns WITHOUT rescheduling), so a timer
  // firing mid-flush can't splice an empty delta into a real block's deltas; `resumeHeartbeat` re-arms a
  // fresh interval so the INTER-block idle still gets keepalives. The block-level path suspends around each
  // boundary flush loop; the whole-response path keeps using freezeHeartbeat (a one-shot terminal commit).
  let heartbeatSuspended = false
  // Re-arm hook set on the heartbeat-ON path (below, once `tick`/`intervalMs` exist). Stays a no-op on the
  // heartbeat-OFF path so `resumeHeartbeat` is a defined-but-inert primitive there (parity with freezeHeartbeat).
  let rearmHeartbeat = (): void => {}
  // One-shot guard so concurrent/re-entrant ticks can't fire a second anchor injection (which would
  // collide block indices). Reset to false when an injection reports `did===false` (pre-message_start),
  // so the NEXT idle tick retries once message_start has arrived (spec §3.3 lazy injection).
  let anchorAttempted = false

  // Real frame → sample forwarded + write. noteRealFrame BEFORE the await so a timer
  // firing mid-write sees the fresh ts and skips a redundant ping.
  const write = (frame: ClientFrame): Promise<void> => {
    lastRealMs = Date.now()
    noteBlockState(frame) // update open-block state from real forwarded frames (provider mode only)
    // A synthetic-origin frame (tagged via `tagFrameSynthetic`, frame-origin.ts) samples forwarded
    // with its `synthetic` kind — `"hook-rewrite"` (a `upstream.inbound` hook changed the frame)
    // or `"refusal-recovery"` (refusal recovery's injected end_turn text / rewritten delta / error
    // frame). Same forwarded-only treatment as the other synthetic markers (keepalive/anchor), just
    // driven by a per-frame TAG read off the frame itself rather than a distinct write method: such a
    // frame is REGULAR content flowing through this SAME `write()` call as every other real frame, so
    // the driver has no separate call site to route it through (unlike writeKeepalive/writeAnchor,
    // which the driver/handler always calls deliberately for its OWN synthesized frames).
    sampleForwarded(frame, readSyntheticKind(frame))
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
    sampleForwarded(frame, undefined, "synthetic")
    return writeSse(frame)
  }

  // A proxy-synthesized keepalive the HANDLER injects out-of-band (the cold-start commit's immediate
  // first ping). Sampled into the forwarded track with a `synthetic:"keepalive"` marker so it's never
  // mistaken for real content (the internal heartbeat timer marks its own pings the same way).
  const writeKeepalive = (frame: ClientFrame): Promise<void> => {
    sampleForwarded(frame, "keepalive")
    return writeSse(frame)
  }

  // A proxy-synthesized FABRICATED `message_start` envelope (fake id + zeroed usage) the injector writes
  // ahead of the anchor block when the upstream stalled before ever emitting its own real message_start
  // (live pre-response silence, or the buffered pre-message_start window — spec keepalive timeout-safety
  // §10.2). Sampled into the forwarded track with a `synthetic:"synthetic-message-start"` marker so
  // history/UI/logs never mistake the fabricated envelope for a real one (its fake id + usage:0 is an
  // accepted wire/billing divergence — richest-data-flow). Unlike writeAnchor it does NOT touch the
  // open-block state: a message_start opens no content block, so noteBlockState is a deliberate no-op on it
  // (the anchor's content_block_start@0, written via writeAnchor, is what lights openBlock={0,text}).
  const writeSyntheticEnvelope = (frame: ClientFrame): Promise<void> => {
    sampleForwarded(frame, "synthetic-message-start")
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
  let deliveryFinalized = false
  const finalize = (): void => {
    close()
    if (deliveryFinalized) return
    deliveryFinalized = true
    onDeliveryFinalized?.()
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

  // suspendHeartbeat / resumeHeartbeat — the RECOVERABLE per-block-flush guard (spec §4.4). suspend flips
  // the flag the tick top-guards on: a timer firing while suspended early-returns WITHOUT injecting AND
  // WITHOUT rescheduling (so no empty delta lands mid-block). resume re-arms a FRESH interval (counted from
  // resume, `lastRealMs` reset) so the inter-block idle keeps getting keepalives. `rearmHeartbeat` clears any
  // still-live timer before arming so a suspend→resume WITHIN one interval (no tick fired) leaves EXACTLY one
  // timer (never a double-ping). Idempotent: resume is a no-op when not suspended (the single live timer is
  // untouched); both are inert no-ops on the heartbeat-OFF path (rearmHeartbeat stays the empty default).
  const suspendHeartbeat = (): void => {
    heartbeatSuspended = true
  }
  const resumeHeartbeat = (): void => {
    if (!heartbeatSuspended) return
    heartbeatSuspended = false
    lastRealMs = Date.now()
    if (stopped) return // closed sink — don't resurrect a timer
    rearmHeartbeat()
  }

  if (!heartbeatOn) {
    return { write, writeSynthetic, writeKeepalive, writeSyntheticEnvelope, writeAnchor, close, finalize, freezeHeartbeat, suspendHeartbeat, resumeHeartbeat }
  }

  const intervalMs = heartbeat.intervalSec * 1000
  // Emit ONE keepalive frame (fixed ping, or provider-chosen block-aware empty delta) into the
  // forwarded track + wire. Does NOT reschedule the timer (each caller reschedules as appropriate).
  const emitKeepalive = (): void => {
    // Synthetic keepalive — a FIXED ping frame, or (provider mode) a block-aware empty delta chosen
    // from the current open block. Sampled into the forwarded track (a keepalive IS a proxy→client
    // frame), shares the chain (no byte-interleave). Errors swallowed: the next real write hits the
    // same closed stream and routes through the driver's outcome path.
    const frame = typeof heartbeat.pingFrame === "function" ? heartbeat.pingFrame(currentOpenBlock()) : heartbeat.pingFrame
    sampleForwarded(frame, "keepalive")
    void writeSse(frame).catch(() => undefined)
    lastRealMs = Date.now()
  }
  const tick = (): void => {
    if (stopped || heartbeatSuspended || heartbeat.clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      // Buffered empty_text anchor (§3.3): the forward stream has NO open block yet → light one by
      // asking the driver-supplied closure to forward message_start + the empty-text anchor block
      // (through the PUBLIC write, so noteBlockState pushes openBlock={0,text} onto the stack). Runs BEFORE
      // the provider frame is chosen — a provider called with no open block would only yield a bare ping.
      if (heartbeat.injectAnchor && openBlockStack.length === 0 && !anchorAttempted && !everOpenedRealBlock) {
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
  // Wire the resume re-arm (now that `tick`/`intervalMs` exist): clear any still-live timer, then arm a
  // fresh interval + unref. Clearing first makes a suspend→resume WITHIN one interval leave EXACTLY one
  // timer (a suspended tick that already fired left a dead chain; one that didn't left a live timer we must
  // not duplicate). Guarded by `stopped` inside `resumeHeartbeat`, so a post-close resume never resurrects.
  rearmHeartbeat = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, intervalMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  return { write, writeSynthetic, writeKeepalive, writeSyntheticEnvelope, writeAnchor, close, finalize, freezeHeartbeat, suspendHeartbeat, resumeHeartbeat }
}

/** {@link makeWsSink} options — forwarded-track sampling (optional) + forward-idle heartbeat (optional). */
export interface WsSinkOptions {
  /**
   * Forwarded-track sampler invoked per written frame (→ history `inboundResponse.sseEvents`).
   * The record shape (offsetMs / parsed-type / raw bytes) mirrors the legacy `forwardWsFrame`
   * push (`{type: event.type, raw: forwardData}`; `frameType` yields the parsed JSON `type`).
   */
  onForwarded?: (record: SseEventRecord) => void
  /** History V3 arena hook, invoked at the same unique client-wire sampling point. */
  onGenerationFrame?: (frame: ClientFrame, record: SseEventRecord, syntheticKind?: SseEventRecord["synthetic"]) => void
  /** Stream-start reference for the forwarded record `offsetMs` (defaults to now). */
  streamStartMs?: number
  /**
   * Forward-idle keepalive (omitted / `intervalSec<=0` → no timer). The WS analog of
   * {@link SseSinkHeartbeat} — a Codex-style WS consumer resets its idle deadline on application
   * MESSAGES, and a Bun protocol ping (auto-sent, `websocket.sendPings` default true) surfaces to a
   * standard WS client as a `ping` EVENT, never a `message` — so protocol pings keep the SOCKET alive
   * but do NOT reset an app-level idle clock (the WS parallel of "a bare SSE comment doesn't reset
   * Codex's SSE clock"). Hence the WS path injects the SAME app-layer keepalive frame the SSE path
   * does (R3.5; empirically固化 in responses-ws-keepalive.unit.test.ts).
   */
  heartbeat?: WsSinkHeartbeat
  /** 首包埋点（spec 2026-07-14 §3.2）：同 {@link SseSinkOptions} — 格式无关谓词 + 首次命中回调。 */
  isRealContentFrame?: (frame: ClientFrame) => boolean
  onFirstRealContent?: () => void
  /** Delivery-boundary callback; invoked once by `sink.finalize()` after terminal WS send/close. */
  onDeliveryFinalized?: () => void
}

/**
 * Forward-idle heartbeat config for {@link makeWsSink}. The fixed-frame subset of {@link SseSinkHeartbeat}:
 * WS frames carry only `data` (no content-block structure to derive a block-aware delta from), so the
 * ping is always a FIXED frame — never a provider — and there is no anchor path.
 */
export interface WsSinkHeartbeat {
  /** Seconds of client-forward silence before a synthetic keepalive is injected (<=0 disables). */
  intervalSec: number
  /** The FIXED keepalive frame to inject on forward-idle (Responses: `responsesKeepaliveFrame()`). */
  pingFrame: ClientFrame
  /** Suppress pings once the client has disconnected (a ping to a departed client is wasteful). */
  clientAbortSignal?: AbortSignal
}

/**
 * A minimal forward-idle heartbeat timer for a FIXED keepalive frame — the generic core the WS sink
 * uses (the SSE sink keeps its own richer block-aware/anchor variant inline, so this stays private to
 * `client-sink.ts` and never touches `makeSseSink`'s behavior). Fires `emit` once each time
 * `intervalSec` elapses with no `noteActivity()` (a real forwarded frame) since the last emit/frame;
 * after a ping the next interval counts from the ping (mirrors `emitKeepalive`'s `lastRealMs` reset).
 * `noteActivity` (called by the sink's real `write`) pushes the deadline out. `stop` (idempotent) is
 * called by the sink's `close` so a self-rescheduling timer can't leak; every timer is `unref`'d for
 * the same reason. Pings are suppressed once `clientAbortSignal` is aborted.
 */
function startFixedForwardIdleHeartbeat(
  intervalSec: number,
  emit: () => void,
  clientAbortSignal?: AbortSignal,
): { noteActivity: () => void; stop: () => void } {
  const intervalMs = intervalSec * 1000
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const arm = (ms: number): void => {
    timer = setTimeout(tick, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  function tick(): void {
    if (stopped || clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      emit()
      lastRealMs = Date.now() // count the next interval from THIS ping (parity with emitKeepalive)
      arm(intervalMs)
    } else {
      arm(intervalMs - elapsed)
    }
  }
  arm(intervalMs)
  return {
    noteActivity: () => {
      lastRealMs = Date.now()
    },
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/** WS sink — writes JSON frame strings through a Hono `WSContext` (the Responses WS path). */
export function makeWsSink(ws: WSContext, opts: WsSinkOptions = {}): ClientSink {
  const { onForwarded, onGenerationFrame, streamStartMs = Date.now(), heartbeat, isRealContentFrame, onFirstRealContent, onDeliveryFinalized } = opts
  const enqueue = makeSerializer()
  // 首包埋点（spec 2026-07-14 §3.2）：客户端首个真实内容帧只捕获一次。
  let firstRealFired = false

  // Sample the forwarded track synchronously at call time (before the enqueued send). WS frames carry
  // only `data` (no SSE event/id/retry line), matching legacy `ws.send`. `synthetic` marks a proxy-
  // injected keepalive OR a hook-rewritten frame so history/UI/logs never mistake either for real
  // unaltered upstream content.
  const sampleForwarded = (
    frame: ClientFrame,
    synthetic?: "keepalive" | "hook-rewrite" | "refusal-recovery" | "error-shaping-canonical" | "error-shaping-auq",
    generationSynthetic: SseEventRecord["synthetic"] = synthetic,
  ): void => {
    const record: SseEventRecord = { offsetMs: Date.now() - streamStartMs, type: frameType(frame), raw: frame.data ?? "", ...(synthetic ? { synthetic } : {}) }
    onForwarded?.(record)
    onGenerationFrame?.(frame, record, generationSynthetic)
    // 首包埋点：首个非-synthetic 真实内容帧 → ctx firstReal（handler 绑定谓词/回调）。
    if (!synthetic && !firstRealFired && isRealContentFrame?.(frame)) {
      firstRealFired = true
      onFirstRealContent?.()
    }
  }
  const sendRaw = (frame: ClientFrame): Promise<void> =>
    enqueue(() => {
      ws.send(frame.data ?? "")
    })

  // Forward-idle heartbeat — armed only when configured. Built BEFORE `write` so `write` can push the
  // idle countdown out on every real frame. `hb` is undefined on the no-heartbeat path, so `write`'s
  // `hb?.noteActivity()` no-ops and the returned sink omits `close` — byte-identical to before Task 2.2.
  const heartbeatOn = heartbeat !== undefined && heartbeat.intervalSec > 0
  const hb =
    heartbeatOn ?
      startFixedForwardIdleHeartbeat(
        heartbeat.intervalSec,
        // Emit ONE app-layer keepalive frame into the forwarded track (marked) + wire. Errors are
        // swallowed: the next real write hits the same closed stream and routes through the driver's
        // outcome path (same as the SSE sink's `emitKeepalive`).
        () => {
          sampleForwarded(heartbeat.pingFrame, "keepalive")
          void sendRaw(heartbeat.pingFrame).catch(() => undefined)
        },
        heartbeat.clientAbortSignal, // client disconnect suppresses pings
      )
    : undefined

  // Real frame → note activity (resets the idle countdown) + sample forwarded (marked
  // `hook-rewrite` when tagged, Task 2.3 — see makeSseSink's `write` for the full rationale) + send.
  const write = (frame: ClientFrame): Promise<void> => {
    hb?.noteActivity()
    sampleForwarded(frame, readSyntheticKind(frame))
    return sendRaw(frame)
  }
  // A handler-synthesized terminal error frame IS a proxy→client frame (the WS analog of the HTTP
  // `writeSynthetic`) — sample + send it identically so it lands in `inboundResponse.sseEvents`. Does
  // NOT note activity (it's terminal). The handler must `recordForwarded()` after this and before
  // `ctx.fail` (see makeSseSink).
  const writeSynthetic = (frame: ClientFrame): Promise<void> => {
    sampleForwarded(frame, undefined, "synthetic")
    return sendRaw(frame)
  }

  // `close` stops the heartbeat timer — runResponseSink's `finally` MUST call it on every exit so a
  // self-rescheduling timer can't leak (the timer is also `unref`'d). Omitted with no heartbeat.
  let deliveryFinalized = false
  const finalize = (): void => {
    hb?.stop()
    if (deliveryFinalized) return
    deliveryFinalized = true
    onDeliveryFinalized?.()
  }
  return hb ? { write, writeSynthetic, close: hb.stop, finalize } : { write, writeSynthetic, finalize }
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
