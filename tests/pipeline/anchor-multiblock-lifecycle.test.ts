/**
 * Anchor lifecycle across MULTIPLE block-level commits (spec 2026-07-11-block-level-buffered-retry §4.3;
 * fixes the two defects the P1-Task-6 adversarial review confirmed — see .superpowers/sdd/p1-wiring-report.md
 * concern #2 + docs/todo/deferred-backlog.md "anchor 注入器可在真实块之间二次触发").
 *
 * This is the PRODUCER wire-oracle the existing e2e (which only REPLAYS a hand-built ideal fixture) never
 * had: it drives the REAL `runResponseBufferedSink` with a real anchor injector + `anthropicCommitBoundaries`
 * + a MULTI-block upstream WITH inter-block silence, and asserts the proxy actually PRODUCES the spec §4.3
 * shape — anchor@0 stays OPEN across all blocks, so an inter-block idle carries a `text_delta@0` (which resets
 * Claude Code's 300s no-real-content watchdog, exp/cc-idle-280s/REPORT.md) and NOT a bare `ping` (which does
 * not). Two independent bugs are locked:
 *
 *   (b) HIGH — driver `flushBufferedFrames` closed the anchor at the FIRST block boundary (the old
 *       `firstFlush` gate), so inter-block gaps degraded to a bare ping → 300s disconnect. Fixed: the
 *       close-off is gated on the TERMINAL flush, not the first flush.
 *   (a) MEDIUM — sink heartbeat could RE-fire `injectAnchor` between real blocks when the anchor was NEVER
 *       injected (fast first block, then a later inter-block idle), forwarding a duplicate message_start +
 *       a colliding content_block_start@0. Fixed: an `everOpenedRealBlock` guard on the injection gate.
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
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
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

/**
 * An upstream that yields `segments[0]`, then parks until `releases[0]()`, then yields `segments[1]`, parks
 * on `releases[1]()`, … — a controllable multi-stall stream (each gap is a silent inter-block window).
 */
function makeGatedUpstream(segments: Array<Array<UpstreamFrame>>): { stream: UpstreamStream; releases: Array<() => void> } {
  const gates: Array<Promise<void>> = []
  const releases: Array<() => void> = []
  for (let i = 0; i < segments.length - 1; i++) {
    let rel!: () => void
    gates.push(
      new Promise<void>((r) => {
        rel = r
      }),
    )
    releases.push(rel)
  }
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (let i = 0; i < segments.length; i++) {
      for (const fr of segments[i]) yield fr
      if (i < gates.length) await gates[i]
    }
  }
  return { stream: { frames: gen(), headers: new Headers() }, releases }
}

// ── mock codec / driver (identity render — Anthropic bypass-direct) ───────────

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
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
    send: () => Promise.reject(new Error("no re-exchange in the anchor-lifecycle path")),
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

/** Terminal-signal tracker fed by onUpstreamFrame — REAL (only flips on the real frame, never a constant). */
function makeStopTracker() {
  let saw = false
  let sawErr = false
  return {
    onUpstreamFrame: (frame: UpstreamFrame) => {
      try {
        const t = (JSON.parse(frame.data ?? "{}") as { type?: string }).type
        if (t === "message_stop") saw = true
        if (t === "error") sawErr = true
      } catch {
        /* ignore */
      }
    },
    onAttemptReset: () => {
      saw = false
      sawErr = false
    },
    sawMessageStop: () => saw,
    sawUpstreamError: () => sawErr,
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

async function drain(n = 40): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 25; i++) await Promise.resolve()
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

function parse(w: { data: string }): { type: string; index?: number; delta?: { type?: string; text?: string } } {
  return JSON.parse(w.data) as { type: string; index?: number; delta?: { type?: string; text?: string } }
}

describe("anchor lifecycle across multiple block-level commits — PRODUCER wire-oracle (§4.3)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("(b) anchor injected pre-commit stays OPEN across blocks: an inter-block idle carries text_delta@0, NOT a bare ping", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // segment 0: real message_start (captured, buffered) → STALL #1 (pre-content) → the idle tick injects the
    //   empty-text anchor (message_start forwarded + content_block_start@0 + empty text_delta@0).
    // segment 1: a full real text block (its content_block_stop@0 is a commit boundary → block committed live,
    //   remapped +1) → STALL #2 (INTER-BLOCK) → this is the frame under test.
    // segment 2: a second real text block + terminal.
    const { stream: up, releases } = makeGatedUpstream([
      [f("message_start", { message: { id: "msg_mb" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "text" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
        f("content_block_stop", { index: 0 }),
      ],
      [
        f("content_block_start", { index: 1, content_block: { type: "text" } }),
        f("content_block_delta", { index: 1, delta: { type: "text_delta", text: "bye" } }),
        f("content_block_stop", { index: 1 }),
        f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
        f("message_stop"),
      ],
    ])

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      commitBoundaries: anthropicCommitBoundaries,
      retryCap: 0,
    } as RunBufferedOpts)

    // STALL #1: pull message_start (CAPTURE), park; the idle tick injects the anchor.
    await drain(40)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true) // the anchor WAS injected pre-commit

    // Release segment 1 → block@0 buffers + commits at its content_block_stop (remapped +1). Park on STALL #2.
    releases[0]()
    await drain(40)
    await flush()

    // ── THE ORACLE (§4.3): the inter-block idle keepalive MUST be a text_delta@0, not a bare ping. ──
    // Snapshot the wire, fire ONE idle interval, inspect exactly the frame(s) that tick produced.
    const beforeGap = written.length
    await clock.advance(15_000)
    await flush()
    const gap = written.slice(beforeGap)

    expect(gap).toHaveLength(1) // exactly one keepalive frame from the idle tick
    const g = parse(gap[0])
    expect(gap[0].event).not.toBe("ping") // NOT a bare ping (the pre-fix degradation → 300s CC disconnect)
    expect(g.type).toBe("content_block_delta") // a real content delta …
    expect(g.index).toBe(0) // … on the still-open anchor block@0 …
    expect(g.delta).toEqual({ type: "text_delta", text: "" }) // … an EMPTY text_delta (resets CC's 300s watchdog)

    // Release segment 2 → block@1 commits, terminal closes the anchor → clean drain.
    releases[1]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // ── TERMINAL ORDER ORACLE (§4.3): the anchor close-off `content_block_stop@0` MUST precede the response
    // tail (`message_delta` + `message_stop`), never trail it. The count-only invariants below never pinned
    // the POSITION of stop@0, which is exactly how the malformed order (`… message_stop, content_block_stop@0`)
    // slipped through. Assert the exact ordered suffix of the whole wire. Pre-fix (message_stop treated as a
    // commit boundary) the tail flushes IN-LOOP and stop@0 trails at the terminal drain → RED.
    const seq = written.map((w) => {
      const p = parse(w)
      return p.index === undefined ? p.type : `${p.type}@${p.index}`
    })
    expect(seq.slice(-4)).toEqual([
      "content_block_stop@2", // last real block (block@1 remapped +1)
      "content_block_stop@0", // anchor close-off — BEFORE the tail (defect (b′): it must not trail message_stop)
      "message_delta",
      "message_stop",
    ])

    // Structural invariants over the whole wire:
    // exactly ONE content_block_stop@0 (the anchor close-off at the TERMINAL, not at block@0's boundary).
    const stop0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_stop" && p.index === 0
    })
    expect(stop0s).toHaveLength(1)
    // message_start forwarded EXACTLY once; NO bare ping anywhere in the stream.
    expect(written.filter((w) => parse(w).type === "message_start")).toHaveLength(1)
    expect(written.some((w) => w.event === "ping")).toBe(false)
    // real blocks live at @1 and @2 (anchor holds @0); anchor stop@0 is the LAST content_block_stop before terminal.
    expect(written.some((w) => parse(w).type === "content_block_start" && parse(w).index === 1)).toBe(true)
    expect(written.some((w) => parse(w).type === "content_block_start" && parse(w).index === 2)).toBe(true)
    void anchorState
    sink.close?.()
  })

  test("(c) H2 error terminus with an open anchor: close-off content_block_stop@0 precedes the forwarded error frame (§5.3/§10.5)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // segment 0: real message_start → STALL (pre-content) → the idle tick injects the anchor.
    // segment 1: a real text block (commits at its content_block_stop, remapped +1) → then a terminal upstream
    //   `error` frame (H2 — e.g. overloaded), then a CLEAN drain (NO message_stop). `error` is BOTH a commit
    //   boundary AND the response terminus, so its in-loop flush must be TERMINAL: the anchor close-off
    //   content_block_stop@0 must precede the forwarded error frame (symmetry with the live-pump reconcile H2
    //   branch + the buffered success terminus). Pre-fix the error flushed non-terminal → stop@0 trailed it.
    const { stream: up, releases } = makeGatedUpstream([
      [f("message_start", { message: { id: "msg_h2" } })],
      [
        f("content_block_start", { index: 0, content_block: { type: "text" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
        f("content_block_stop", { index: 0 }),
        f("error", { error: { type: "overloaded_error", message: "overloaded" } }),
      ],
    ])

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      commitBoundaries: anthropicCommitBoundaries,
      retryCap: 0,
    } as RunBufferedOpts)

    // STALL: pull message_start (CAPTURE), park; the idle tick injects the anchor.
    await drain(40)
    await clock.advance(15_000)
    await flush()
    expect(lastInjectResult()).toBe(true)

    // Release the terminal segment → block@0 commits (remapped +1), then the error terminus flushes.
    releases[0]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete") // H2 commits + the handler fails via acc.streamError (mirrors live)

    // ── TERMINAL ORDER ORACLE (§5.3/§10.5): the anchor close-off precedes the error terminus. ──
    const seq = written.map((w) => {
      const p = parse(w)
      return p.index === undefined ? p.type : `${p.type}@${p.index}`
    })
    expect(seq.slice(-3)).toEqual([
      "content_block_stop@1", // the real text block (remapped +1)
      "content_block_stop@0", // anchor close-off — BEFORE the error terminus, not after it
      "error",
    ])
    // Exactly ONE anchor close-off — the later terminal drain's empty-buffer re-flush is short-circuited by
    // the `anchorClosed` guard (no second stop@0).
    const stop0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_stop" && p.index === 0
    })
    expect(stop0s).toHaveLength(1)
    void anchorState
    sink.close?.()
  })

  test("(a) fast first block then inter-block idle: NO duplicate message_start, NO second content_block_start@0 (re-injection guarded)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // No pre-content stall → the anchor is NEVER injected. A real block opens/closes FAST (at its own index 0),
    // then a LATER inter-block idle must NOT re-trigger injectAnchor (which pre-fix forwarded a 2nd message_start
    // + a colliding content_block_start@0). segment boundaries: block@0 fast, then STALL, then terminal.
    const { stream: up, releases } = makeGatedUpstream([
      [
        f("message_start", { message: { id: "msg_fast" } }),
        f("content_block_start", { index: 0, content_block: { type: "text" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
        f("content_block_stop", { index: 0 }),
      ],
      [f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }), f("message_stop")],
    ])

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildAnchoredSink(sseStream)
    const tracker = makeStopTracker()

    const outcomeP = driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      anchor,
      anchorState,
      commitBoundaries: anthropicCommitBoundaries,
      retryCap: 0,
    } as RunBufferedOpts)

    // Drain segment 0 → message_start captured, block@0 commits FAST at its content_block_stop (no stall → no
    // injection). Park on the inter-block gate.
    await drain(40)
    await flush()
    expect(lastInjectResult()).toBeUndefined() // the anchor never fired (no pre-content stall)

    // INTER-BLOCK IDLE: fire an interval. The re-injection guard must hold — a bare ping, no synthetic prelude.
    const beforeGap = written.length
    await clock.advance(15_000)
    await flush()
    const gap = written.slice(beforeGap)
    // exactly one keepalive; it is a bare ping (no anchor was ever injected → honest fallback, spec scenario-B).
    expect(gap).toHaveLength(1)
    expect(gap[0].event).toBe("ping")
    // CRITICALLY: the idle tick did NOT re-inject — no synthetic message_start, no second content_block_start@0.
    expect(gap.some((w) => parse(w).type === "message_start")).toBe(false)
    expect(gap.some((w) => parse(w).type === "content_block_start")).toBe(false)

    releases[0]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Whole-wire structural oracle (fails pre-fix (a): a duplicate message_start + a colliding start@0).
    expect(written.filter((w) => parse(w).type === "message_start")).toHaveLength(1)
    const start0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1) // the ONE real text block — never a colliding synthetic anchor@0
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text")
    void anchorState
    sink.close?.()
  })
})
