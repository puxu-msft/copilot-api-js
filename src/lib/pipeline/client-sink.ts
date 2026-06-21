/**
 * v4 pipeline — ClientSink factories (Stage B B1, design §3.3).
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
 * B1 ships the `write` path + serialization only; `writeSynthetic` (heartbeat) and a
 * real `close` (timer teardown) land in B2.
 */

import type { SSEStreamingApi } from "hono/streaming"
import type { WSContext } from "hono/ws"

import type { ClientFrame } from "./types"
import type { ClientSink } from "./types"

/**
 * Forward-idle heartbeat config for {@link makeSseSink} (Stage B B2). The format
 * supplies the ping FRAME (Anthropic `event: ping` / `{type:"ping"}`) — the sink stays
 * format-agnostic. `intervalSec <= 0` disables it. Mirrors `startForwardedSseHeartbeat`
 * (streaming-pump.ts) but lives in the sink so `write` naturally notes the last-real-frame
 * time. The forwarded-only SAMPLING of injected pings is wired in B4.
 */
export interface SseSinkHeartbeat {
  /** Seconds of client-forward silence before a synthetic ping is injected (<=0 disables). */
  intervalSec: number
  /** The already-terminal-form ping frame to inject (format-specific). */
  pingFrame: ClientFrame
  /** Suppress pings once the client has disconnected. */
  clientAbortSignal?: AbortSignal
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

/** SSE sink — writes through Hono's `streamSSE` API (the Anthropic/CC/Responses/Gemini HTTP path). */
export function makeSseSink(stream: SSEStreamingApi, heartbeat?: SseSinkHeartbeat): ClientSink {
  const enqueue = makeSerializer()
  const sseWrite = (frame: ClientFrame): Promise<void> =>
    enqueue(() => stream.writeSSE({ data: frame.data ?? "", ...(frame.event !== undefined && { event: frame.event }) }))

  // No heartbeat → the bare write path (still single-chain serialized).
  if (!heartbeat || heartbeat.intervalSec <= 0) {
    return { write: sseWrite }
  }

  // Forward-idle (SOFT) racer: inject a ping after `intervalSec` of write-silence to keep
  // the CLIENT connection alive. It does NOT touch the upstream-idle guard (transport-
  // resident, HARD kill) — the two are deliberately SEPARATE racers (design §3.3 / B2
  // two-racer): a heartbeat must not keep a silent-upstream stream alive forever.
  const intervalMs = heartbeat.intervalSec * 1000
  let lastRealMs = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const tick = (): void => {
    if (stopped || heartbeat.clientAbortSignal?.aborted) return
    const elapsed = Date.now() - lastRealMs
    if (elapsed >= intervalMs) {
      // Synthetic ping — shares the chain (no byte-interleave). Forwarded-only sampling
      // is wired in B4; B1/B2 only inject. Errors swallowed: the next real write hits the
      // same closed stream and routes through the driver's outcome/settle path.
      void sseWrite(heartbeat.pingFrame).catch(() => undefined)
      lastRealMs = Date.now()
      timer = setTimeout(tick, intervalMs)
    } else {
      timer = setTimeout(tick, intervalMs - elapsed)
    }
  }
  timer = setTimeout(tick, intervalMs)
  // unref so a leaked timer can never hold the event loop / block graceful shutdown.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return {
    write: (frame) => {
      // noteRealFrame BEFORE the await so a timer firing mid-write sees the fresh ts.
      lastRealMs = Date.now()
      return sseWrite(frame)
    },
    // Public synthetic inject (handler-driven), same chain; B4 adds forwarded-only sampling.
    writeSynthetic: (frame) => sseWrite(frame),
    close: () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
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
