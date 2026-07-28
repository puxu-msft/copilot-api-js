/**
 * Anchor lifecycle across MULTIPLE block-level commits — SEQUENTIAL anchor (spec 2026-07-22
 * §3.3; supersedes the earlier anchor-COEXIST shape of spec 2026-07-11-block-level-buffered-retry §4.3).
 *
 * This is the PRODUCER wire-oracle the existing e2e (which only REPLAYS a hand-built ideal fixture) never
 * had: it drives the REAL `runResponseBufferedSink` with a real anchor injector + `anthropicCommitBoundaries`
 * + a MULTI-block upstream WITH inter-block silence, and asserts the proxy actually PRODUCES the spec §3.3
 * SEQUENTIAL shape — at most ONE content block open at a time (`maxOpen===1`), the CLI-safety invariant.
 * The pre-content anchor is CLOSED (`content_block_stop@0`) BEFORE the first real `content_block_start`
 * (never coexist — the coexist shape, anchor@0 kept open across real blocks, stalls the Claude Code CLI
 * agent loop, exp/block-level-anchor-sequential/FINDINGS.md); real blocks then shift +1. After the anchor
 * closes, an inter-block idle degrades to a BARE ping (there is no open block to carry a `text_delta@0` —
 * resetting CC's 300s no-real-content watchdog for >300s inter-block gaps is a SEPARATE concern,
 * docs/todo/2026-07-22-client-proxy-keepalive-300s.md). Two independent bugs remain locked:
 *
 *   (b→c′) the anchor close-off must precede the first real block / the error terminus — the SEQUENTIAL
 *       close-before-real (driver `flushBufferedFrames`) replaces the old coexist "keep open across blocks,
 *       close at the terminal flush" behavior; test (c′) locks the zero-content error-terminus ordering.
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
  makeSyntheticEnvelopeInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { resolveAnthropicKeepalive } from "~/lib/anthropic/keepalive-frame"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
import { createRequestContext } from "~/lib/context/request"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"
import {
  //
  assertBlockProtocolState,
  assertMonotonicWireIndices,
} from "../helpers/wire-index-oracle"

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
    for (const [i, segment] of segments.entries()) {
      for (const fr of segment) yield fr
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
    isContentBlockStart: (fr: { data?: string }) => {
      try {
        return (JSON.parse(fr.data ?? "{}") as { type?: unknown }).type === "content_block_start"
      } catch {
        return false
      }
    },
    isMessageStart: (fr) => {
      try {
        return typeof fr.data === "string" && (JSON.parse(fr.data) as { type?: string }).type === "message_start"
      } catch {
        return false
      }
    },
    startFrame: anchorStartFrame,
    stopFrame: anchorStopFrame,
    deltaFrame: anchorDeltaFrame,
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

/**
 * `enveloped_ping` sibling of {@link buildAnchoredSink}: the ENVELOPE-ONLY injector
 * ({@link makeSyntheticEnvelopeInjector}) + the fixed bare-ping keepalive frame
 * (`resolveAnthropicKeepalive("enveloped_ping")`) instead of the block-aware provider. This mode's
 * injector never opens a synthetic anchor block (`anchorBlockOpen` stays false — see
 * keepalive-anchor.ts docstring), so the `everOpenedRealBlock` guard is exercised for its OTHER
 * purpose here: preventing a duplicate `message_start` / colliding `content_block_start@0` re-fire
 * once a real block has already opened+closed, independent of which injector is wired.
 */
function buildEnvelopedPingSink(stream: Parameters<typeof makeSseSink>[0]): {
  sink: ClientSink
  anchor: AnchorHooks
  anchorState: AnchorState
  lastInjectResult: () => boolean | undefined
} {
  const anchorState: AnchorState = { injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false }
  const anchor: AnchorHooks = {
    isContentBlockStart: (fr: { data?: string }) => {
      try {
        return (JSON.parse(fr.data ?? "{}") as { type?: unknown }).type === "content_block_start"
      } catch {
        return false
      }
    },
    isMessageStart: (fr) => {
      try {
        return typeof fr.data === "string" && (JSON.parse(fr.data) as { type?: string }).type === "message_start"
      } catch {
        return false
      }
    },
    startFrame: anchorStartFrame,
    stopFrame: anchorStopFrame,
    deltaFrame: anchorDeltaFrame,
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  let lastInjectResult: boolean | undefined
  const realInjector = makeSyntheticEnvelopeInjector({
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
  const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: resolveAnthropicKeepalive("enveloped_ping"), injectAnchor } })
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

  test("(b) SEQUENTIAL anchor: closes BEFORE the first real block; inter-block idle is a bare ping (never coexist)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // segment 0: real message_start (captured, buffered) → STALL #1 (pre-content) → the idle tick injects the
    //   empty-text anchor (message_start forwarded + content_block_start@0 + empty text_delta@0).
    // segment 1: a full real text block → its content_block_stop@0 is a commit boundary → the flush CLOSES the
    //   anchor (content_block_stop@0) BEFORE the real content_block_start (sequential — spec 2026-07-22 §3.3),
    //   then remaps the real block +1. STALL #2 (INTER-BLOCK) → this is the frame under test.
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

    // Release segment 1 → block@0 buffers + commits: the flush closes the anchor (stop@0) BEFORE the real
    // content_block_start, then writes the real block remapped +1. Park on STALL #2.
    releases[0]()
    await drain(40)
    await flush()

    // ── SEQUENTIAL ORACLE (§3.3): after the first real block, the anchor is CLOSED, so the inter-block idle
    // keepalive is a BARE ping at the ordinary cadence (there is no open block to carry an empty text_delta).
    // The separate on-demand deadline now upgrades near 300s; this short test only locks the P1 CLI-safety
    // property: at most ONE block open at a time. ──
    const beforeGap = written.length
    await clock.advance(15_000)
    await flush()
    const gap = written.slice(beforeGap)

    expect(gap).toHaveLength(1) // exactly one keepalive frame from the idle tick
    expect(gap[0].event).toBe("ping") // a BARE ping — the anchor is already closed (sequential, never coexist)

    // Release segment 2 → block@1 commits (remapped +1), terminal clean drain.
    releases[1]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // ── SEQUENTIAL ORDER ORACLE (§3.3): the anchor close-off `content_block_stop@0` precedes the FIRST real
    // content_block_start (@1), NOT the terminal tail. The terminal suffix is just the last real block's stop
    // + the response tail (no trailing anchor stop@0 — it closed early). ──
    const seq = written.map((w) => {
      const p = parse(w)
      return p.index === undefined ? p.type : `${p.type}@${p.index}`
    })
    // anchor closes BEFORE the first real block opens
    const stop0Idx = seq.indexOf("content_block_stop@0")
    const start1Idx = seq.indexOf("content_block_start@1")
    expect(stop0Idx).toBeGreaterThanOrEqual(0)
    expect(stop0Idx).toBeLessThan(start1Idx) // close-before-real (sequential)
    // terminal suffix: last real block stop + tail, NO trailing anchor stop@0
    expect(seq.slice(-3)).toEqual(["content_block_stop@2", "message_delta", "message_stop"])

    // Structural invariants: exactly ONE anchor close-off (stop@0); message_start once; real blocks at @1/@2.
    const stop0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_stop" && p.index === 0
    })
    expect(stop0s).toHaveLength(1)
    expect(written.filter((w) => parse(w).type === "message_start")).toHaveLength(1)
    expect(written.some((w) => parse(w).type === "content_block_start" && parse(w).index === 1)).toBe(true)
    expect(written.some((w) => parse(w).type === "content_block_start" && parse(w).index === 2)).toBe(true)

    // ── Full producer invariants: starts are monotonic and every delta/stop references the unique open block.
    assertMonotonicWireIndices(written)
    assertBlockProtocolState(written)
    void anchorState
    sink.close?.()
  })

  test("(c) SEQUENTIAL anchor + H2 error terminus: anchor closes BEFORE the real block; error trails at the end", async () => {
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

    // ── SEQUENTIAL ORDER ORACLE (§3.3): the anchor closes BEFORE the first real block (@1), so by the time
    // the H2 error terminus arrives the anchor is already closed — the error simply trails at the end. The
    // ordered prefix around the first real block is stop@0 → start@1; the suffix ends in the error. ──
    const seq = written.map((w) => {
      const p = parse(w)
      return p.index === undefined ? p.type : `${p.type}@${p.index}`
    })
    const stop0Idx = seq.indexOf("content_block_stop@0")
    const start1Idx = seq.indexOf("content_block_start@1")
    expect(stop0Idx).toBeGreaterThanOrEqual(0)
    expect(stop0Idx).toBeLessThan(start1Idx) // anchor closed before the real block (sequential)
    expect(seq.slice(-2)).toEqual([
      "content_block_stop@1", // the real text block (remapped +1)
      "error", // H2 terminus trails at the end (anchor already closed early)
    ])
    // Exactly ONE anchor close-off — the terminal drain's empty-buffer re-flush is short-circuited by the
    // `anchorClosed` guard (no second stop@0).
    const stop0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_stop" && p.index === 0
    })
    expect(stop0s).toHaveLength(1)
    // CLI-safety: at most one block open at a time.
    let open = 0
    let maxOpen = 0
    for (const w of written) {
      const p = parse(w)
      if (p.type === "content_block_start") open++
      if (p.type === "content_block_stop") open--
      maxOpen = Math.max(maxOpen, open)
    }
    expect(maxOpen).toBe(1)
    void anchorState
    sink.close?.()
  })

  // Lock the ONE corner where the terminal-flush close-off (`isTerminalFlush`, fed by
  // `isErrorTerminusFlush = sawUpstreamError()` at driver.ts) is LOAD-BEARING and NOT redundant with
  // the per-frame close-before-real (driver.ts:1105): a ZERO-CONTENT terminal `error` — the anchor was
  // injected during a pre-content stall, then the upstream errors WITHOUT ever opening a real content
  // block. The per-frame `isContentBlockStart` close-off never fires (there is no real content_block_start
  // in the buffer), so ONLY the top-of-flush `if (isTerminalFlush) closeAnchorBeforeReal()` closes the
  // anchor BEFORE the error frame. Drop the `sawUpstreamError()` term and the ordering flips to
  // `error → stop@0` (an OPEN anchor block@0 immediately followed by `event: error` — protocol-incomplete);
  // no other test catches that flip. (The removed `attempt > 0` term was separately DEAD — a recovery
  // candidate's first committed block carries a content_block_start → the per-frame close-off already
  // handles it — and was removed with this test in place.)
  test("(c′) SEQUENTIAL anchor + ZERO-CONTENT error terminus: anchor stop@0 precedes the error (no real block ever)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // segment 0: real message_start → STALL (pre-content) → the idle tick injects the anchor.
    // segment 1: a terminal upstream `error` frame with NO real content block before it, then a CLEAN drain
    //   (no message_stop). `error` is a commit boundary AND the terminus; its in-loop flush is TERMINAL
    //   (sawUpstreamError → isErrorTerminusFlush true), so the anchor close-off content_block_stop@0 must
    //   precede the forwarded error frame — the ONLY site that can close it (no real content_block_start).
    const { stream: up, releases } = makeGatedUpstream([
      [f("message_start", { message: { id: "msg_zero" } })],
      [f("error", { error: { type: "overloaded_error", message: "overloaded" } })],
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

    // Release the terminal error segment → the zero-content error terminus flushes.
    releases[0]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete") // H2 commits + the handler fails via acc.streamError (mirrors live)

    const seq = written.map((w) => {
      const p = parse(w)
      return p.index === undefined ? p.type : `${p.type}@${p.index}`
    })
    // The anchor block@0 opened (start@0 + empty text_delta@0), then closed (stop@0) BEFORE the error.
    const stop0Idx = seq.indexOf("content_block_stop@0")
    const errIdx = seq.indexOf("error")
    expect(stop0Idx).toBeGreaterThanOrEqual(0)
    expect(errIdx).toBeGreaterThanOrEqual(0)
    expect(stop0Idx).toBeLessThan(errIdx) // stop@0 precedes error (balanced block structure)
    // The error trails at the very end; there is NEVER a real content block (@1).
    expect(seq.at(-1)).toBe("error")
    expect(seq.includes("content_block_start@1")).toBe(false)
    // Exactly ONE anchor close-off (idempotent — the terminal drain's empty-buffer re-flush short-circuits).
    const stop0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_stop" && p.index === 0
    })
    expect(stop0s).toHaveLength(1)
    // CLI-safety: at most one block open at a time (the anchor block, opened then closed).
    let open = 0
    let maxOpen = 0
    for (const w of written) {
      const p = parse(w)
      if (p.type === "content_block_start") open++
      if (p.type === "content_block_stop") open--
      maxOpen = Math.max(maxOpen, open)
    }
    expect(maxOpen).toBe(1)
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

  // Regression lock for the `enveloped_ping` re-injection guard (found while writing this golden,
  // 2026-07-14 — see docs/todo/deferred-backlog.md "enveloped_ping 模式的 everOpenedRealBlock 守卫零防护"
  // for the root-cause writeup). `everOpenedRealBlock` is only ever set inside `noteBlockState`
  // (client-sink.ts), which used to be gated on `trackOpenBlock = heartbeatOn && typeof
  // heartbeat.pingFrame === "function"` — TRUE only for the block-aware `empty_text` provider mode.
  // `enveloped_ping`'s keepalive frame is a FIXED object, not a function, so `trackOpenBlock` was FALSE
  // for this mode and `everOpenedRealBlock` never flipped true no matter how many real blocks streamed
  // through — the guard's `!everOpenedRealBlock` term was permanently vacuous for `enveloped_ping`, so a
  // fast first block followed by an inter-block idle re-fired `injectAnchor()`, re-forwarding the real
  // captured `message_start` a second time onto the wire. Fixed by widening `trackOpenBlock` to also
  // fire whenever `heartbeat.injectAnchor` is configured (any anchor mode), not just when `pingFrame` is
  // a provider function — purely additive, `empty_text` behavior is unaffected. This test guards the
  // enveloped_ping re-injection path specifically; keep it a normal (non-`.failing`) test going forward.
  test("(a′) enveloped_ping — fast first block then inter-block idle: NO duplicate message_start, NO second content_block_start@0 (re-injection guarded)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // No pre-content stall → the envelope is NEVER injected. A real block opens/closes FAST (at its own index
    // 0), then a LATER inter-block idle must NOT re-trigger injectAnchor (which would forward a 2nd
    // message_start). segment boundaries: block@0 fast, then STALL, then terminal.
    const { stream: up, releases } = makeGatedUpstream([
      [
        f("message_start", { message: { id: "msg_fast_ep" } }),
        f("content_block_start", { index: 0, content_block: { type: "text" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
        f("content_block_stop", { index: 0 }),
      ],
      [f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }), f("message_stop")],
    ])

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const { sink, anchor, anchorState, lastInjectResult } = buildEnvelopedPingSink(sseStream)
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
    expect(lastInjectResult()).toBeUndefined() // the envelope never fired (no pre-content stall)
    expect(anchorState.anchorBlockOpen).toBe(false) // enveloped_ping never opens a block — no index to collide on

    // INTER-BLOCK IDLE: fire an interval. The re-injection guard must hold — a bare ping, no synthetic prelude
    // (mirrors test (a)'s deliberate scenario-B assertion: enveloped_ping's honest fallback is a bare ping,
    // NEVER a text_delta — this mode's own keepalive frame is the fixed ANTHROPIC_PING, not the block-aware
    // provider, so there is no text_delta to assert even when a block IS open elsewhere).
    const beforeGap = written.length
    await clock.advance(15_000)
    await flush()
    const gap = written.slice(beforeGap)
    expect(gap).toHaveLength(1) // exactly one keepalive frame from the idle tick
    expect(gap[0].event).toBe("ping")
    // CRITICALLY: the idle tick did NOT re-inject — no synthetic message_start, no second content_block_start@0.
    expect(gap.some((w) => parse(w).type === "message_start")).toBe(false)
    expect(gap.some((w) => parse(w).type === "content_block_start")).toBe(false)

    releases[0]()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Whole-wire structural oracle: exactly one message_start (the real one), exactly one content_block_start@0
    // (the real block — enveloped_ping never remaps, so it stays at its ORIGINAL index 0, unlike empty_text's
    // +1 shift in test (a)).
    expect(written.filter((w) => parse(w).type === "message_start")).toHaveLength(1)
    const start0s = written.filter((w) => {
      const p = parse(w)
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0s).toHaveLength(1) // the ONE real text block — never a colliding synthetic re-injection
    expect((JSON.parse(start0s[0].data) as { content_block: { type: string } }).content_block.type).toBe("text")
    expect(anchorState.anchorClosed).toBe(false) // no anchor block was ever opened — nothing to close off
    sink.close?.()
  })
})
