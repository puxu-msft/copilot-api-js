/**
 * Driver buffered RETREAT path × empty-text keepalive anchor (spec 2026-07-11-block-level-buffered-retry §6.3,
 * backlog "retreated (OOM cap) + empty_text 锚点 → index 碰撞 + 双 message_start", :251-257).
 *
 * The OOM-cap retreat branch of `runResponseBufferedSink` abandons buffering and switches to live
 * write-through. Before this fix its buffer flush + live continuation forwarded frames RAW — so when the
 * heartbeat had already injected an empty-text anchor (index 0 reserved + one message_start forwarded), the
 * retreat re-sent the buffered message_start (DOUBLE message_start) and forwarded the real `content_block_*`
 * at their original index 0 (COLLISION with the anchor's @0). This suite locks the fix: on retreat while the
 * anchor is injected, BOTH the buffered flush AND the subsequent live-write frames must (1) close the anchor
 * off once (`content_block_stop@0`), (2) H1-dedup the already-forwarded message_start, and (3) +1-remap every
 * real `content_block_*` — exactly mirroring the terminal-commit transform (`flushBufferedFrames`).
 *
 * Harness mirrors buffered-anchor.unit.test.ts (real SSE sink + handler-owned unique injector reading the
 * SHARED AnchorState the driver's retreat path also reads).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

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

/** An upstream that yields every frame without parking (fast — the heartbeat never fires). */
function makeUpstream(frames: Array<UpstreamFrame>): UpstreamStream {
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (const fr of frames) yield fr
  }
  return { frames: gen(), headers: new Headers() }
}

/** An upstream that yields `head`, parks until `release()`, yields `tail`, then THROWS `err` (a transport RST). */
function makeControlledUpstreamThrowing(head: Array<UpstreamFrame>, tail: Array<UpstreamFrame>, err: Error): { stream: UpstreamStream; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (const fr of head) yield fr
    await gate
    for (const fr of tail) yield fr
    throw err
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
    send: () => Promise.reject(new Error("no re-exchange on the retreat path (retreat forfeits retry)")),
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

/** sawMessageStop tracker fed by onUpstreamFrame. */
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
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Map each written frame to `type` or `type@index` — a precise ordered oracle over the forwarded track. */
function seqOf(written: Array<{ data: string; event?: string }>): Array<string> {
  return written.map((w) => {
    const p = JSON.parse(w.data) as { type: string; index?: number }
    return typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
  })
}

function buildAnchoredSink(stream: Parameters<typeof makeSseSink>[0]): {
  sink: ClientSink
  anchor: AnchorHooks
  anchorState: AnchorState
  lastInjectResult: () => boolean | undefined
} {
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
  const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor } })
  sinkHolder.current = sink
  return { sink, anchor, anchorState, lastInjectResult: () => lastInjectResult }
}

// A padded real content_block_start whose bytes alone blow past a small buffer cap — forcing the retreat to
// fire on THIS frame (so the flush carries the buffered message_start + this remapped block start, and the
// block's delta/stop land on the LIVE continuation — exercising BOTH the flush AND live-write remap).
const BIG = "x".repeat(2000)

describe("runResponseBufferedSink — retreat path × injected anchor (§6.3 index collision + double message_start)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("retreat after anchor injected: close anchor off, dedup message_start, remap real blocks +1 across the flush/live seam", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured, small → buffered under the cap; silent stall then triggers injection).
    // tail = a real thinking block (its padded START blows the cap → retreat) + terminal. The block start is
    // in the buffer at retreat (flushed); its delta/stop arrive AFTER retreat (live write-through).
    const { stream: up, release } = makeControlledUpstream(
      [f("message_start", { message: { id: "msg_ret" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: BIG } }),
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
    let retreated = false

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      retryCap: 3,
      bufferCapBytes: 200, // message_start (~55B) buffers under the cap; the padded block start blows it → retreat
      onRetreat: () => {
        retreated = true
      },
    } as RunBufferedOpts)

    // Pull message_start (CAPTURE), park; the idle heartbeat injects the anchor (msg_start + start@0 + delta@0).
    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the stall → the padded thinking block buffers, blows the cap → RETREAT → flush + live drain.
    release()
    const outcome = await outcomeP
    expect(retreated).toBe(true)
    expect(outcome.kind).toBe("complete")

    // ORACLE (fails pre-fix): exactly ONE message_start; exactly ONE content_block_start@0 (the anchor, text);
    // the real thinking block remapped to @1 across the flush (start@1) AND the live continuation (delta@1/stop@1).
    expect(seqOf(written)).toEqual([
      "message_start", // injection: real captured message_start (unmarked)
      "content_block_start@0", // anchor (text)
      "content_block_delta@0", // anchor empty text_delta
      "content_block_stop@0", // anchor close-off at the retreat flush (once)
      "content_block_start@1", // real thinking, remapped +1 (FLUSHED buffered frame)
      "content_block_delta@1", // real thinking_delta, remapped +1 (LIVE write-through)
      "content_block_stop@1", // real stop, remapped +1 (LIVE write-through)
      "message_delta", // no index → unchanged (LIVE)
      "message_stop", // no index → unchanged (LIVE)
    ])
    // No index-0 collision: the only content_block_start@0 is the anchor text block.
    const start0s = written.filter((w) => {
      const p = JSON.parse(w.data) as { type: string; index?: number }
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1)
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text")
    // The real thinking block landed at @1 (start + delta + stop all remapped).
    const start1 = written.find((w) => JSON.parse(w.data).type === "content_block_start" && JSON.parse(w.data).index === 1)
    expect(JSON.parse(start1!.data).content_block.type).toBe("thinking")
    expect(written.filter((w) => JSON.parse(w.data).delta?.type === "thinking_delta").every((w) => JSON.parse(w.data).index === 1)).toBe(true)
    // No DOUBLE message_start: forwarded exactly once (the injection copy; the buffered copy is deduped at flush).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    sink.close?.()
  })

  test("retreat after anchor injected THEN truncation → stream-error: anchor closed EXACTLY once (retreat flush, not M1 double), real block remapped", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // head = message_start (captured; stall → injection). tail = a padded real block start (blows cap → retreat)
    // then the stream TRUNCATES (no message_stop). retryCap 0 → the retreated path returns stream-error. The
    // retreat flush already closed the anchor off (stop@0); the post-retreat M1 `closeAnchorIfOpen` must be
    // idempotent (shared `anchorClosed`) and NOT emit a second stop@0.
    const { stream: up, release } = makeControlledUpstreamThrowing(
      [f("message_start", { message: { id: "msg_rt_err" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: BIG } }),
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "abc" } }),
      ],
      new Error("Stream closed with error code NGHTTP2_CANCEL"), // transport RST after the retreat → stream-error
    )
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()
    let retreated = false

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      retryCap: 0,
      bufferCapBytes: 200,
      onRetreat: () => {
        retreated = true
      },
    } as RunBufferedOpts)

    await drain(30)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    release()
    const outcome = await outcomeP
    expect(retreated).toBe(true)
    expect(outcome.kind).toBe("stream-error")

    // The anchor stop@0 was written EXACTLY once (by the retreat flush) — the post-retreat M1 close-off is a
    // no-op because the retreat flush already set the shared `anchorClosed`. No double stop@0, no @0 collision.
    expect(seqOf(written)).toEqual([
      "message_start",
      "content_block_start@0", // anchor (text)
      "content_block_delta@0", // anchor empty text_delta
      "content_block_stop@0", // anchor close-off — ONCE (retreat flush)
      "content_block_start@1", // real thinking, remapped +1 (retreat flush)
      "content_block_delta@1", // real thinking_delta, remapped +1 (live write-through)
    ])
    expect(written.filter((w) => JSON.parse(w.data).type === "content_block_stop" && JSON.parse(w.data).index === 0)).toHaveLength(1)
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    expect(anchorState.anchorClosed).toBe(true)
    sink.close?.()
  })

  test("retreat with NO anchor injected (fast response) is byte-identical: no stop@0, no remap, message_start once", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // Fast response (no stall → no injection). The padded block start blows the cap → retreat, but with no
    // anchor injected the retreat transform is INERT — real blocks keep index 0, no synthetic frames.
    const up = makeUpstream([
      f("message_start", { message: { id: "msg_noanchor" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: BIG } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "xyz" } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      f("message_stop"),
    ])
    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()
    let retreated = false

    const outcome = await driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      retryCap: 3,
      bufferCapBytes: 200,
      onRetreat: () => {
        retreated = true
      },
    } as RunBufferedOpts)

    expect(retreated).toBe(true)
    expect(outcome.kind).toBe("complete")
    expect(lastInjectResult()).toBeUndefined() // anchor never fired
    // Byte-identical to the no-anchor retreat: original indices, zero synthetic frames, one message_start.
    expect(seqOf(written)).toEqual(["message_start", "content_block_start@0", "content_block_delta@0", "content_block_stop@0", "message_delta", "message_stop"])
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    expect(written.some((w) => w.event === "content_block_stop" && JSON.parse(w.data).index === 0 && JSON.parse(w.data).synthetic)).toBe(false)
    const start0 = written.find((w) => JSON.parse(w.data).type === "content_block_start")
    expect(JSON.parse(start0!.data).content_block.type).toBe("thinking")
    sink.close?.()
  })
})
