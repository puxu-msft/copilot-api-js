/**
 * Driver buffered anchor orchestration (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.2 / §10.1.5).
 *
 * Drives `runResponseBufferedSink` directly with a mock codec/transport + a REAL RequestContext + a real
 * SSE sink whose `heartbeat.injectAnchor` is the handler-owned UNIQUE injector ({@link makeSyntheticAnchorInjector},
 * reading the SHARED AnchorState the driver's commit/close-off/remap also read). Scenario: buffered empty_text,
 * upstream emits message_start then goes silent; the heartbeat cadence expires → the injector forwards the
 * captured message_start (or synthesizes one) + the synthetic empty-text anchor block (content_block_start@0)
 * + a first empty text_delta@0; commit closes the anchor off + remaps real blocks +1 + dedups message_start.
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

/** An upstream that yields `head`, then parks until `release()`, then yields `tail` (simulates a silent stall). */
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
    send: () => Promise.reject(new Error("no re-exchange in the injection-path test")),
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

/** Block-aware provider (function → the sink tracks the open block). Only used if a 2nd tick fires. */
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
 * via a `sinkRef` self-reference (the injector reads its sink at CALL time, since sink construction args are
 * evaluated before the sink exists). The SAME `anchorState` is passed to `runResponseBufferedSink` so the
 * driver's buffered commit/close-off/remap and the injector observe ONE object. `lastInjectResult` surfaces
 * the injector's last return (true=injected, false=couldn't, undefined=never fired) for the assertions.
 */
function buildAnchoredSink(
  stream: Parameters<typeof makeSseSink>[0],
  opts: { onForwarded?: (record: SseEventRecord) => void } = {},
): { sink: ClientSink; anchor: AnchorHooks; anchorState: AnchorState; lastInjectResult: () => boolean | undefined } {
  const anchorState: AnchorState = { injected: false, messageStartForwarded: false, anchorClosed: false }
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
    ...(opts.onForwarded && { onForwarded: opts.onForwarded }),
  })
  sinkHolder.current = sink
  return { sink, anchor, anchorState, lastInjectResult: () => lastInjectResult }
}

describe("runResponseBufferedSink — buffered empty_text anchor injection path (Task 3.2)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("idle heartbeat injects real message_start + anchor start@0 + empty text_delta@0 onto the forwarded track", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({}) // simulate runRequest's first exchange (attempt 0)
    const { stream: up, release } = makeControlledUpstream([f("message_start", { message: { id: "msg_anchor" } })], [f("message_stop")])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Let the buffered loop pull message_start (CAPTURE it) then park awaiting the silent gate.
    await drain(30)
    expect(written).toEqual([]) // buffered: message_start NOT forwarded yet (nothing on the wire)

    // Upstream is silent → advance past the heartbeat cadence → the tick injects the anchor.
    await clock.advance(15_000)
    await flush()

    // anchorState.injected (observed via the injector's true return).
    expect(lastInjectResult()).toBe(true)
    // EXACT forwarded sequence: real message_start, synthetic anchor content_block_start@0, empty text_delta@0.
    expect(written).toEqual([
      { data: JSON.stringify({ type: "message_start", message: { id: "msg_anchor" } }), event: "message_start" },
      { data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), event: "content_block_start" },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), event: "content_block_delta" },
    ])
    // pre-commit transparency: the ONLY content_block_delta is the synthetic empty anchor (no REAL delta).
    const realContentDeltas = written.filter((w) => w.event === "content_block_delta" && !w.data.includes('"text":""'))
    expect(realContentDeltas).toEqual([])

    // Release the stall so the buffered call settles. Do NOT assert the post-commit stream — Task 3.3
    // (commit close-off + message_start dedup) is not built yet, so the flush re-sends message_start here.
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")
    sink.close?.()
  })

  test("buffered pre-message_start window: no captured message_start → injector SYNTHESIZES a prelude, not a ping (spec §10.2/§10.8 M2)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // Upstream emits NOTHING then parks — the buffered loop never captures a message_start before the
    // heartbeat fires. The relocated UNIQUE injector then SYNTHESIZES a message_start (fake id + usage:0)
    // rather than falling back to a bare ping (the pre-response incident fix). The real "late" message_start
    // that arrives after release is DEDUPED at commit (messageStartForwarded), so the client sees exactly one.
    const { stream: up, release } = makeControlledUpstream([], [f("message_start", { message: { id: "late" } }), f("message_stop")])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)
    await drain(30)

    await clock.advance(15_000)
    await flush()

    // Synthesized (NOT a bare ping): the injector returned true and wrote a fabricated message_start + anchor.
    expect(lastInjectResult()).toBe(true)
    expect(written.some((w) => w.event === "ping")).toBe(false)
    // The first forwarded frame is the SYNTHETIC message_start (fake id + zeroed usage — spec §10.2).
    expect(JSON.parse(written[0].data)).toMatchObject({ type: "message_start", message: { id: "msg_synthetic_test", usage: { input_tokens: 0 } } })
    expect(seqOf(written)).toEqual(["message_start", "content_block_start@0", "content_block_delta@0"])

    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // The real "late" message_start is deduped → the client sees exactly ONE message_start (the synthetic),
    // the anchor is closed off at commit, and no bare ping ever appeared (§10.8 M2: single message_start).
    const messageStarts = written.filter((w) => JSON.parse(w.data).type === "message_start")
    expect(messageStarts).toHaveLength(1)
    expect(JSON.parse(messageStarts[0].data).message.id).toBe("msg_synthetic_test")
    expect(seqOf(written)).toEqual(["message_start", "content_block_start@0", "content_block_delta@0", "content_block_stop@0", "message_stop"])
    sink.close?.()
  })
})

// ── Task 3.3: commit close-off + index remap +1 + message_start dedup (C1/H1/M4) ──

/** An upstream that yields every frame without parking (fast response — no idle stall). */
function makeUpstream(frames: Array<UpstreamFrame>): UpstreamStream {
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (const fr of frames) yield fr
  }
  return { frames: gen(), headers: new Headers() }
}

/** Map each written frame to `type` or `type@index` — a precise ordered oracle over the forwarded track. */
function seqOf(written: Array<{ data: string; event?: string }>): Array<string> {
  return written.map((w) => {
    const p = JSON.parse(w.data) as { type: string; index?: number }
    return typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
  })
}

describe("runResponseBufferedSink — buffered empty_text anchor commit close-off (Task 3.3)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("commit with injected anchor: freeze heartbeat, close anchor, remap real +1, skip forwarded message_start", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured, then silent stall triggers injection); tail = a real thinking block + terminal.
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_c" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "abc" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        f("message_stop"),
      ],
    )
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Pull message_start (CAPTURE), park; then the idle heartbeat injects the anchor.
    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the stall → tail buffers → clean drain (saw message_stop) → COMMIT.
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Precise ordered oracle: injection (msg_start, anchor start@0, anchor delta@0) then commit
    // (anchor stop@0 close-off, real block remapped to @1, terminal). No index collision, no dup.
    expect(seqOf(written)).toEqual([
      "message_start",
      "content_block_start@0", // anchor (text)
      "content_block_delta@0", // anchor empty text_delta
      "content_block_stop@0", // anchor close-off (C1 freeze → stop before flush)
      "content_block_start@1", // real thinking, remapped +1 (M4)
      "content_block_delta@1", // real thinking_delta, remapped +1
      "content_block_stop@1", // real stop, remapped +1
      "message_delta", // no index → unchanged
      "message_stop",
    ])
    // H1: the real message_start is forwarded EXACTLY once (not re-sent by the buffer flush).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    // The @0 block is the anchor (text); the @1 block is the real thinking — no collision.
    const start0 = written.find((w) => JSON.parse(w.data).type === "content_block_start" && JSON.parse(w.data).index === 0)
    const start1 = written.find((w) => JSON.parse(w.data).type === "content_block_start" && JSON.parse(w.data).index === 1)
    expect(JSON.parse(start0!.data).content_block.type).toBe("text")
    expect(JSON.parse(start1!.data).content_block.type).toBe("thinking")
    // The remapped real thinking_delta lands at index 1.
    const thinkingDelta = written.find((w) => JSON.parse(w.data).delta?.type === "thinking_delta")
    expect(JSON.parse(thinkingDelta!.data).index).toBe(1)
    sink.close?.()
  })

  test("commit without anchor (fast response) is byte-identical: no stop(0) anchor, no remap, message_start once", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // Fast response: every frame arrives immediately → the heartbeat never fires (clock never advances).
    const up = makeUpstream([
      f("message_start", { message: { id: "msg_fast" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "xyz" } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      f("message_stop"),
    ])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)
    expect(outcome.kind).toBe("complete")

    // Anchor never fired (no injection attempt reached completion) → byte-identical to the no-anchor path.
    expect(lastInjectResult()).toBeUndefined()
    // Real blocks keep their ORIGINAL indices (no +1 remap); NO synthetic anchor frames at all.
    expect(seqOf(written)).toEqual(["message_start", "content_block_start@0", "content_block_delta@0", "content_block_stop@0", "message_delta", "message_stop"])
    // message_start once; the only @0 content_block_start is the REAL thinking (no anchor text block).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    const start0 = written.find((w) => JSON.parse(w.data).type === "content_block_start")
    expect(JSON.parse(start0!.data).content_block.type).toBe("thinking")
    sink.close?.()
  })
})

// ── Task 3.4: terminal-failure anchor close-off (M1) + C1 adversarial mid-flush freeze ──

/**
 * A stub SSE stream whose Nth (0-based `pauseAt`) `writeSSE` PARKS on a gate the test releases — it
 * pushes the frame, then suspends. This lets the test advance the FakeClock while a `sink.write` await
 * is genuinely pending mid-flush (the C1 adversarial timing: a heartbeat that WOULD fire mid-flush must
 * be blocked by the commit's `freezeHeartbeat`). `paused()` reports whether the write is currently parked.
 */
function pausableSseStream(pauseAt: number): {
  stream: Parameters<typeof makeSseSink>[0]
  written: Array<{ data: string; event?: string }>
  releaseGate: () => void
  paused: () => boolean
} {
  const written: Array<{ data: string; event?: string }> = []
  let count = 0
  let isPaused = false
  let releaseGate!: () => void
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  const stream = {
    writeSSE: async (m: { data: string; event?: string }): Promise<void> => {
      const idx = count++
      written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) })
      if (idx === pauseAt) {
        isPaused = true
        await gate
        isPaused = false
      }
    },
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written, releaseGate, paused: () => isPaused }
}

describe("runResponseBufferedSink — terminal-failure anchor close-off (Task 3.4)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("terminal failure after anchor injected: freeze + close anchor stop@0 before returning stream-error", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured → anchor injection on the idle stall); tail = EMPTY, so releasing the
    // stall yields a clean drain WITHOUT message_stop = truncation. retryCap 0 → exhausted → the failure
    // return must FIRST close the still-open anchor block so the client sees no dangling open block.
    const { stream: up, release } = makeControlledUpstream([f("message_start", { message: { id: "msg_fail" } })], [])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the (empty) stall → clean drain WITHOUT message_stop = truncation → exhausted (retryCap 0).
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("stream-error")

    // The anchor content_block_start@0 was OPEN on the forwarded track; the terminal-failure return must
    // close it (content_block_stop@0) BEFORE surfacing the stream-error. The handler then writes its
    // protocol error frame — but the structural anchor block is already balanced.
    expect(seqOf(written)).toEqual([
      "message_start",
      "content_block_start@0", // anchor (text)
      "content_block_delta@0", // anchor empty text_delta
      "content_block_stop@0", // anchor close-off BEFORE the stream-error return (M1)
    ])
    // Last forwarded frame is the anchor stop@0 — nothing dangles open.
    const last = JSON.parse(written.at(-1)!.data) as { type: string; index: number }
    expect(last.type).toBe("content_block_stop")
    expect(last.index).toBe(0)
    // The buffered message_start is NOT re-sent by the close-off path (only the anchor stop is written).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    sink.close?.()
  })

  test("no anchor injected → terminal failure writes NO anchor stop (nothing to close)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // Fast truncation: message_start arrives immediately then the stream ends (no stall → no injection).
    const up = makeUpstream([f("message_start", { message: { id: "msg_none" } })])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)
    expect(outcome.kind).toBe("stream-error")

    // Anchor never fired → closeAnchorIfOpen is inert → the forwarded track has ZERO synthetic frames.
    expect(lastInjectResult()).toBeUndefined()
    expect(written.some((w) => w.event === "content_block_stop")).toBe(false)
    expect(written.some((w) => w.event === "content_block_start")).toBe(false)
    sink.close?.()
  })
})

// ── Task 5.1: synthetic markers on the forwarded track (anchor vs keepalive vs real) ──

describe("runResponseBufferedSink — Task 5.1 synthetic markers on the forwarded track", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("anchor start/stop marked synthetic:'anchor'; anchor first + heartbeat deltas 'keepalive'; real frames unmarked", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured → injection on the idle stall); tail = a real THINKING block + terminal.
    // The real block is thinking (not text) so it is unambiguously distinguishable from the text anchor block.
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_syn" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "abc" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        f("message_stop"),
      ],
    )
    const driver = makeDriver()
    const { stream: sseStream } = stubSseStream()
    // Collect the FORWARDED-track records (history `inboundResponse.sseEvents`) with their synthetic markers.
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream, {
      onForwarded: (r) => forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }),
    })
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Pull message_start (CAPTURE), park; first idle tick injects the anchor (start@0 + first empty text_delta@0).
    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // A SECOND idle tick (openBlock={0,text} is now lit, still no real content) → heartbeat emits ANOTHER empty
    // text_delta@0 on the open anchor block — a keepalive continuation, marked synthetic:"keepalive".
    await clock.advance(15_000)
    await flush()

    // Release the stall → tail buffers → clean drain (saw message_stop) → COMMIT (anchor stop@0, real +1 remap).
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Precise ordered oracle over the FORWARDED track: `type@index#synthetic` (synthetic omitted when unmarked).
    const seq = forwarded.map((r) => {
      const p = JSON.parse(r.raw) as { type: string; index?: number }
      const key = typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
      return r.synthetic ? `${key}#${r.synthetic}` : key
    })
    expect(seq).toEqual([
      "message_start", // real (captured message_start forwarded via sink.write) — NO marker
      "content_block_start@0#anchor", // synthetic anchor block start — "anchor"
      "content_block_delta@0#keepalive", // anchor's first empty text_delta — "keepalive"
      "content_block_delta@0#keepalive", // heartbeat-continued empty text_delta — "keepalive"
      "content_block_stop@0#anchor", // anchor close-off at commit — "anchor"
      "content_block_start@1", // real thinking, remapped +1 — NO marker
      "content_block_delta@1", // real thinking_delta, remapped +1 — NO marker
      "content_block_stop@1", // real stop, remapped +1 — NO marker
      "message_delta", // real — NO marker
      "message_stop", // real — NO marker
    ])
    // Cross-check: every REAL frame (message_start, real content blocks, message_delta/stop) is unmarked.
    const realUnmarked = forwarded.filter((r) => {
      const p = JSON.parse(r.raw) as { type: string; index?: number }
      return p.type === "message_start" || p.type === "message_delta" || p.type === "message_stop" || p.index === 1
    })
    expect(realUnmarked.every((r) => r.synthetic === undefined)).toBe(true)
    sink.close?.()
  })
})

describe("runResponseBufferedSink — C1 adversarial: freeze holds across a mid-flush clock jump (Task 3.4)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("clock advanced while a commit-flush write is PARKED injects NO second anchor / no ping (freeze holds)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured → injection on stall); tail = a real text block + terminal → COMMIT.
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_c1" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        f("message_stop"),
      ],
    )
    const driver = makeDriver()
    // Injection writes 3 frames (message_start, anchor start@0, anchor delta@0). The commit flush's FIRST
    // write is the anchor close-off (content_block_stop@0) at absolute index 3 — PARK there. At that instant
    // `noteBlockState(stopFrame)` has already cleared openBlock (===undefined) = the exact window a rogue
    // tick would try to inject/ping. Freeze (cleared the timer at commit start) must hold across the jump.
    const { stream: sseStream, written, releaseGate, paused } = pausableSseStream(3)
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Pull message_start (CAPTURE), park; idle heartbeat injects the anchor (reschedules a NEW timer).
    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the stall → tail buffers → clean drain (saw message_stop) → COMMIT → freeze → flush begins →
    // the anchor stop@0 write (index 3) PARKS on the gate.
    release()
    await drain(50)
    expect(paused()).toBe(true) // the flush is genuinely suspended mid-write (a `sink.write` await is pending)

    const writtenAtPause = written.length
    expect(writtenAtPause).toBe(4) // message_start, anchor start@0, anchor delta@0, anchor stop@0

    // Jump the FakeClock PAST the injection-rescheduled heartbeat's fireAt while the flush is parked. Freeze
    // cleared that timer at commit start → NO tick fires → nothing is appended (no 2nd anchor, no ping).
    await clock.advance(60_000)
    await flush()
    expect(written.length).toBe(writtenAtPause) // freeze held: zero mid-flush synthetic injection

    // Release the parked write → the flush completes.
    releaseGate()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Exactly ONE content_block_start@0 (the anchor) — no second one snuck in during the clock jump.
    const start0s = written.filter((w) => {
      const p = JSON.parse(w.data) as { type: string; index?: number }
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1)
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text") // the anchor
    // No synthetic keepalive/ping interleaved anywhere (freeze prevented every mid-flush emit).
    expect(written.some((w) => w.event === "ping")).toBe(false)
    // Real block flushed at the remapped index 1 — no collision at index 0.
    expect(seqOf(written)).toEqual([
      "message_start",
      "content_block_start@0", // anchor
      "content_block_delta@0", // anchor delta
      "content_block_stop@0", // anchor close-off (the write that parked)
      "content_block_start@1", // real text, remapped +1 (M4)
      "content_block_delta@1",
      "content_block_stop@1",
      "message_delta", // no index → unchanged
      "message_stop",
    ])
    sink.close?.()
  })
})

// ── B1 adversarial: commit snapshots `injected` while injectAnchor is STILL IN FLIGHT (spec §3.3) ──

/**
 * B1 (whole-branch review Blocking): the C1 window the existing test above does NOT cover. The existing
 * adversarial test parks at the COMMIT-flush write — injection has ALREADY completed (`injected===true`).
 * The uncovered subcase: `injectAnchor` is fire-and-forget from the heartbeat tick, and `freezeHeartbeat`
 * only clears the timer — it CANNOT cancel an injectAnchor already in flight. So a torn window existed:
 * the anchor's `content_block_start@0` was already enqueued on the wire, but (in the pre-fix code, which set
 * `anchorState.injected = true` AFTER the awaits) `injected` was still false. If the commit branch's
 * `const injected = anchorState.injected` snapshot landed in that window it read false → NO +1 remap → the
 * real `content_block_start@0` collided with the anchor's @0 = TWO index-0 blocks = protocol violation.
 *
 * The fix flips `injected` SYNCHRONOUSLY before the first await, so once the anchor's `content_block_start@0`
 * is enqueued, `injected` is already true — no observable torn state. This test reproduces the EXACT window:
 * park injectAnchor at its OWN third write (`content_block_delta@0`, wire index 2) — at that instant the
 * anchor `content_block_start@0` (wire index 1) is already on the wire, and the pre-fix code had NOT yet
 * run `anchorState.injected = true` (it sat after this parked write). Then drive the commit to snapshot
 * `injected` while that write is genuinely pending. The oracle: exactly ONE `content_block_start@0` (the
 * anchor) + the real block remapped to @1. On the pre-fix code this asserts-FAILS (two @0 starts, no anchor
 * stop, no remap); on the fixed code it passes.
 */
describe("runResponseBufferedSink — B1 adversarial: commit snapshots injected while injectAnchor is in flight (spec §3.3)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("injectAnchor parked at its own delta@0 write (start@0 already enqueued): commit still remaps real to @1, no index-0 collision", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured → injection on the idle stall); tail = a real thinking block + terminal → COMMIT.
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_b1" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "abc" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        f("message_stop"),
      ],
    )
    const driver = makeDriver()
    // PARK at wire index 2 = injectAnchor's THIRD write (content_block_delta@0). At that instant the anchor
    // content_block_start@0 (wire index 1) is already enqueued — the exact torn window. In the pre-fix code
    // `anchorState.injected` was set on the line AFTER this parked write, so a commit snapshot here read false.
    const { stream: sseStream, written, releaseGate, paused } = pausableSseStream(2)
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, { ...tracker, anchor, anchorState, retryCap: 0 } as RunBufferedOpts)

    // Pull message_start (CAPTURE), park on the stall; the idle heartbeat fires injectAnchor. Its first two
    // writes (message_start @wire0, anchor start@0 @wire1) complete; the third (anchor delta@0 @wire2) PARKS.
    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(paused()).toBe(true) // injectAnchor is genuinely suspended mid-write (a sink.write await is pending)
    expect(written.length).toBe(3) // message_start, anchor start@0, anchor delta@0 (the parked one)
    // The anchor content_block_start@0 is ALREADY on the wire — this is the torn window the pre-fix code left open.
    expect(seqOf(written)).toEqual(["message_start", "content_block_start@0", "content_block_delta@0"])

    // Release the stall → tail buffers (no sink writes) → clean drain (saw message_stop) → COMMIT. The commit's
    // `const injected = anchorState.injected` snapshot runs WHILE injectAnchor's delta@0 write is still parked.
    // The fix set injected=true synchronously at injectAnchor entry, so the snapshot sees true → +1 remap.
    release()
    await drain(50)
    // The flush is blocked behind the parked injectAnchor write on the shared serializer → still 3 on the wire.
    expect(paused()).toBe(true)
    expect(written.length).toBe(3)

    // Release the parked write → injectAnchor completes (returns true) → the commit flush drains.
    releaseGate()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")
    expect(lastInjectResult()).toBe(true)

    // ORACLE (fails on pre-fix code): exactly ONE content_block_start@0 (the anchor) and the real block at @1.
    const start0s = written.filter((w) => {
      const p = JSON.parse(w.data) as { type: string; index?: number }
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1) // pre-fix: 2 (anchor @0 + un-remapped real @0) = protocol violation
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text") // the anchor
    // Full ordered oracle: anchor block closed off, real thinking remapped +1, no collision, message_start once.
    expect(seqOf(written)).toEqual([
      "message_start",
      "content_block_start@0", // anchor (text)
      "content_block_delta@0", // anchor empty text_delta (the write that parked)
      "content_block_stop@0", // anchor close-off — proves injected snapshot was true (pre-fix skipped this)
      "content_block_start@1", // real thinking, remapped +1 (proves the +1 remap fired)
      "content_block_delta@1",
      "content_block_stop@1",
      "message_delta",
      "message_stop",
    ])
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1) // message_start exactly once
    const start1 = written.find((w) => JSON.parse(w.data).type === "content_block_start" && JSON.parse(w.data).index === 1)
    expect(JSON.parse(start1!.data).content_block.type).toBe("thinking") // the real block landed at @1
    sink.close?.()
  })
})
