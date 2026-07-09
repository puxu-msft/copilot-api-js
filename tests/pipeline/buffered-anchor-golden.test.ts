/**
 * P2.0 GOLDEN FIXTURE — the逐字节 equivalence oracle for the buffered `empty_text` keepalive ANCHOR
 * path (spec 2026-07-08-buffered-keepalive-empty-text-anchor). This test locks the CURRENT forwarded
 * track — the exact frame sequence, per-frame synthetic marker, and content_block index — of the
 * canonical anchor scenario, so the upcoming "injector moves out of the driver onto the handler"
 * refactor (P2-P5) can be proven frame-for-frame byte-equivalent against this baseline.
 *
 * Scenario (the whole point of the feature — see keepalive-buffered-anchor-e2e.http.test.ts):
 *   1. upstream emits `message_start` (BUFFERED — protect_streaming on withholds it), which the driver
 *      CAPTURES so the idle anchor injector can forward it ahead of the anchor,
 *   2. upstream opens a `content_block_start{thinking}` (also buffered → NO open block on the wire),
 *   3. upstream STALLS past the heartbeat cadence → the idle tick LAZILY INJECTS the synthetic
 *      empty-text anchor (message_start + content_block_start{text:""}@0 + empty text_delta@0) — NOT a
 *      bare ping — so CC's 300s no-real-content watchdog is reset,
 *   4. upstream RESUMES (thinking_delta + stop) and terminates (message_delta + message_stop) → COMMIT:
 *      the anchor is closed off (content_block_stop@0) and the real blocks flush REMAPPED to index+1,
 *      with `message_start` forwarded EXACTLY once (H1 dedup).
 *
 * Golden dimensions (both locked as explicit arrays for frame-by-frame diffing post-refactor):
 *   A) the FORWARDED-track record sequence `type@index#synthetic` (history `inboundResponse.sseEvents`),
 *      surfacing the per-frame synthetic marker (anchor / keepalive / real=unmarked), and
 *   B) the RAW WIRE bytes (the exact `writeSSE` payloads the client receives).
 *
 * Deterministic: FakeClock drives the heartbeat cadence (no wall-clock flake).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { SseEventRecord } from "~/lib/history"
import type { OpenBlock } from "~/lib/pipeline/client-sink"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
  FormatCodec,
  PreparedRequest,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  makeSyntheticAnchorInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { createRequestContext } from "~/lib/context/request"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"

// ── frame fixtures ──────────────────────────────────────────────────────────

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}

/** An upstream that yields `head`, then parks until `release()`, then yields `tail` (a silent stall). */
function makeControlledUpstream(head: Array<UpstreamFrame>, tail: Array<UpstreamFrame>): { stream: UpstreamStream; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (const fr of head) yield fr
    await gate
    for (const fr of tail) yield fr
  }
  return { stream: { frames: gen(), headers: new Headers() }, release }
}

// ── mock codec / driver (identity render — Anthropic bypass-direct) ───────────

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (u) => u,
    formatError: () => ({ event: "error", data: "{}" }) as ClientFrame,
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeEnv(): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: {},
    stream: true,
    body: {},
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function makeDriver() {
  const transport: Transport = {
    send: () => Promise.reject(new Error("no re-exchange in the golden path")),
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

/** sawMessageStop tracker fed by onUpstreamFrame (so the buffered path commits on drain). */
function makeStopTracker() {
  let saw = false
  return {
    onUpstreamFrame: (frame: UpstreamFrame) => {
      try {
        if ((JSON.parse(frame.data ?? "{}") as { type?: string }).type === "message_stop") saw = true
      } catch {
        /* ignore */
      }
    },
    onAttemptReset: () => {
      saw = false
    },
    sawMessageStop: () => saw,
  }
}

/** Block-aware heartbeat frame: an empty text_delta on the open anchor block, else a bare ping. */
const PING: ClientFrame = { event: "ping", data: '{"type":"ping"}' }
const emptyDeltaFor = (ob?: OpenBlock): ClientFrame => {
  if (ob?.type === "text")
    return { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: ob.index, delta: { type: "text_delta", text: "" } }) }
  return PING
}

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
// The FakeClock drains 2 microtasks per timer fire; the injectAnchor chain (async closure → serialized
// public writes → the tick's `.then` → the holder's own `.then`) needs several more turns, so flush
// generously after an anchor tick until the whole chain settles.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * Build the sink + the handler-owned UNIQUE injector the Anthropic handler wires (spec §10.1.5 C1): a
 * shared {@link AnchorState}, the {@link AnchorHooks}, and the injector attached to `heartbeat.injectAnchor`
 * via a `sinkRef` self-reference (the injector reads its sink at CALL time). The SAME `anchorState` is
 * passed to `runResponseBufferedSink` so the driver's buffered commit/close-off/remap and the injector
 * observe ONE object. In this canonical scenario a REAL message_start IS captured, so the injector forwards
 * it UNMARKED (the synthetic-envelope fallback is not exercised) — the golden arrays are unchanged.
 */
function buildAnchoredSink(
  stream: Parameters<typeof makeSseSink>[0],
  onForwarded: (record: SseEventRecord) => void,
): { sink: ClientSink; anchor: AnchorHooks; anchorState: AnchorState; lastInjectResult: () => boolean | undefined } {
  const anchorState: AnchorState = { injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false }
  const anchor: AnchorHooks = {
    isMessageStart: (fr) => {
      try {
        return typeof fr.data === "string" && (JSON.parse(fr.data) as { type?: string }).type === "message_start"
      } catch {
        return false
      }
    },
    startFrame: anchorStartFrame(),
    stopFrame: anchorStopFrame(),
    deltaFrame: anchorDeltaFrame(),
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  let lastInjectResult: boolean | undefined
  const realInjector = makeSyntheticAnchorInjector({
    anchor,
    state: anchorState,
    getSink: () => sinkHolder.current,
    resolvedName: "claude-test",
    reqId: "test",
  })
  const injectAnchor = async (): Promise<boolean> => {
    const did = await realInjector()
    lastInjectResult = did
    return did
  }
  const sink = makeSseSink(stream, {
    heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor },
    onForwarded,
  })
  sinkHolder.current = sink
  return { sink, anchor, anchorState, lastInjectResult: () => lastInjectResult }
}

/** Map each forwarded record to `type@index#synthetic` (synthetic marker omitted when unmarked). */
function forwardedSeq(records: Array<{ raw: string; synthetic?: string }>): Array<string> {
  return records.map((r) => {
    const p = JSON.parse(r.raw) as { type: string; index?: number }
    const key = typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
    return r.synthetic ? `${key}#${r.synthetic}` : key
  })
}

describe("GOLDEN — buffered empty_text anchor forwarded-track baseline (P2.0 equivalence oracle)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("pre-commit thinking stall injects the anchor; commit closes it + remaps real +1 (frozen forwarded + wire golden)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({}) // simulate runRequest's first exchange (attempt 0)

    // head = real message_start (captured) + a thinking content_block_start (buffered → NO open block
    // on the wire during the stall); tail = the resumed thinking block + terminal → COMMIT.
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_golden" } }), f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } })],
      [
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
        f("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "c2ln" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
        f("message_stop"),
      ],
    )

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    // Collect the FORWARDED-track records (history `inboundResponse.sseEvents`) WITH their synthetic markers.
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream, (r) =>
      forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }),
    )
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Let the buffered loop pull message_start (CAPTURE) + the thinking start, then park on the silent gate.
    await drain(30)
    // Upstream is silent → advance past the heartbeat cadence → the idle tick injects the anchor.
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the stall → tail buffers → clean drain (saw message_stop) → COMMIT.
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // ── GOLDEN A: the FORWARDED track (type@index#synthetic) ──────────────────────────────────────
    // This is the survivor-of-the-refactor oracle: injection (real message_start unmarked, synthetic
    // anchor start@0 + keepalive empty text_delta@0) then commit (anchor close-off stop@0, real thinking
    // remapped +1, terminal). Synthetic markers distinguish injected frames from real upstream content.
    expect(forwardedSeq(forwarded)).toEqual([
      "message_start", //                  real message_start — forwarded by the injector, NO marker
      "content_block_start@0#anchor", //   synthetic empty-text anchor block start
      "content_block_delta@0#keepalive", // the anchor's own first empty text_delta (the frame that resets CC's 300s)
      "content_block_stop@0#anchor", //    anchor close-off at commit (C1 freeze → stop before flush)
      "content_block_start@1", //          real thinking block, remapped +1 (M4) — NO marker
      "content_block_delta@1", //          real thinking_delta, remapped +1 — NO marker
      "content_block_delta@1", //          real signature_delta, remapped +1 — NO marker
      "content_block_stop@1", //           real content_block_stop, remapped +1 — NO marker
      "message_delta", //                  real — no index → unchanged, NO marker
      "message_stop", //                   real — NO marker
    ])

    // ── GOLDEN B: the RAW WIRE bytes (exact writeSSE payloads the client receives) ─────────────────
    // The synthetic markers are history-only annotations — they never reach the wire, so the client
    // sees a well-formed Anthropic stream with the anchor block at @0 and the real block at @1.
    expect(written).toEqual([
      { data: JSON.stringify({ type: "message_start", message: { id: "msg_golden" } }), event: "message_start" },
      { data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), event: "content_block_start" },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), event: "content_block_delta" },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }), event: "content_block_stop" },
      { data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }), event: "content_block_start" },
      {
        data: JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "reasoning" } }),
        event: "content_block_delta",
      },
      { data: JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "c2ln" } }), event: "content_block_delta" },
      { data: JSON.stringify({ type: "content_block_stop", index: 1 }), event: "content_block_stop" },
      {
        data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
        event: "message_delta",
      },
      { data: JSON.stringify({ type: "message_stop" }), event: "message_stop" },
    ])

    // Cross-check invariants the golden arrays already encode (explicit for regression readability):
    // (1) NO bare ping — the pre-commit keepalive is the anchor, not a ping.
    expect(written.some((w) => w.event === "ping")).toBe(false)
    // (2) message_start forwarded EXACTLY once (injector forwarded it; the commit flush skips the buffered copy — H1).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    // (3) exactly ONE content_block_start@0 and it is the synthetic text anchor (real thinking sits at @1 — no collision).
    const start0s = written.filter((w) => {
      const p = JSON.parse(w.data) as { type: string; index?: number }
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1)
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text")

    sink.close?.()
  })
})
