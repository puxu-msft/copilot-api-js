/**
 * COLLISION-ELIMINATION E2E (spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.3 / §10.8 "live
 * 对账正确"). The core proof that Phase 4 closes the protocol-collision window the injector relocation
 * opened: a LIVE (non-buffered) delayed-commit stream whose upstream is PURELY pre-response silent — the
 * handler's unique injector synthesizes a full prelude (fabricated message_start + anchor block@0 + empty
 * text_delta) during the stall — and THEN the upstream resumes in LIVE mode, streaming a real message_start
 * + content_block_start@0(thinking) + delta + stop + terminal.
 *
 * WITHOUT reconciliation the client would receive TWO message_starts and a real content_block_start@0 that
 * COLLIDES with the injected anchor at index 0. This test drives the real `driver.runResponseSink` through
 * the {@link makeReconcilingSink} decorator and asserts the client sees exactly ONE message_start, the
 * anchor at @0, and every real block remapped to +1 — no collision, no reordering, real usage/stop_reason
 * delivered.
 *
 * Deterministic: FakeClock drives the heartbeat cadence; a controlled upstream gates the resume.
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
  PhysicalTransport,
  PhysicalTransportResponse,
  PreparedRequest,
  Transport,
  UpstreamDispatchLifecycle,
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
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { createRequestContext } from "~/lib/context/request"
import {
  //
  makeDeliverySseSink,
  makeSseSink,
} from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { createFrozenHedgePolicy } from "~/lib/pipeline/generation/hedge-policy"

import { FakeClock } from "../helpers/fake-clock"

// ── fixtures (mirroring buffered-anchor-golden.test.ts) ──────────────────────

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}

/** An upstream that parks until `release()`, then yields `tail` (pure pre-response silence, no head). */
function makeSilentThenResume(tail: Array<UpstreamFrame>): { stream: UpstreamStream; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  async function* gen(): AsyncIterable<UpstreamFrame> {
    await gate
    for (const fr of tail) yield fr
  }
  return { stream: { frames: gen(), headers: new Headers() }, release }
}

/** An upstream that yields `head`, then parks until `release()`, then yields `tail`. */
function makeHeadThenSilentThenResume(head: Array<UpstreamFrame>, tail: Array<UpstreamFrame>): { stream: UpstreamStream; release: () => void } {
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

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => makeEnv(),
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame, // identity render — Anthropic bypass-direct
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
  const transport: Transport = { send: () => Promise.reject(new Error("no re-exchange on the live path")) }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

function hedgePolicy(enabled: boolean) {
  return createFrozenHedgePolicy({
    enabled,
    thresholdMs: 0,
    maxSecondaryCandidates: 1,
    maxActiveCandidates: 2,
    maxTotalCandidates: 3,
    maxActiveDispatches: 2,
    maxTotalDispatches: 4,
    cleanupMarginMs: 0,
    responseHeaderTimeoutMs: 0,
    requestDeadlineAtMs: 0,
    expectedHedgeCompletionMs: 1,
  })
}

function lifecycle(controller: AbortController): UpstreamDispatchLifecycle {
  let resolve!: () => void
  const quiesced = new Promise<void>((done) => (resolve = done))
  return {
    cancel(reason) {
      if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"))
      resolve()
    },
    async dispose(reason) {
      this.cancel(reason)
      return { quiesced: true, connectionReusable: false }
    },
    quiesced,
  }
}

function makeHedgedDriver(tail: Array<UpstreamFrame>, enabled: boolean) {
  let opens = 0
  const transport: PhysicalTransport = {
    async open(_wire, _env, options): Promise<PhysicalTransportResponse> {
      const isPrimary = opens++ === 0
      const controller = new AbortController()
      options?.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true })
      const owner = lifecycle(controller)
      async function* frames(): AsyncIterable<UpstreamFrame> {
        if (enabled && isPrimary) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("primary cancelled"))
            if (controller.signal.aborted) abort()
            else controller.signal.addEventListener("abort", abort, { once: true })
          })
        }
        for (const frame of tail) yield frame
      }
      return { kind: "stream", upstream: { headers: new Headers(), frames: frames(), lifecycle: owner }, lifecycle: owner }
    },
  }
  return {
    driver: createPipelineDriver({
      codec: makeCodec(),
      transport: {
        ...transport,
        send: async () => {
          throw new Error("legacy send must not run")
        },
      },
      strategies: [],
      maxRetries: 0,
      maxLearningRetries: 0,
      monotonicNow: () => 0,
      hedgePolicy: hedgePolicy(enabled),
    }),
    opens: () => opens,
  }
}

/** Block-aware heartbeat frame: an empty text_delta on the open anchor block, else a bare ping. */
const PING: ClientFrame = { event: "ping", data: '{"type":"ping"}' }
const emptyDeltaFor = (ob?: OpenBlock): ClientFrame =>
  ob?.type === "text" ?
    { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: ob.index, delta: { type: "text_delta", text: "" } }) }
  : PING

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

function anchorHooks(): AnchorHooks {
  return {
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
    startFrame: anchorStartFrame(),
    stopFrame: anchorStopFrame(),
    deltaFrame: anchorDeltaFrame(),
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
}

/**
 * Build the LIVE sink stack the handler wires (spec §10.1.5 C1 / §10.3): the INNER {@link makeDeliverySseSink}
 * carries the handler-owned unique injector on `heartbeat.injectAnchor` (self-referencing the inner sink
 * via a holder), and the DECORATED sink ({@link makeReconcilingSink}) is what the live pump writes real
 * frames to. The injector always writes to the INNER sink (its prelude must NOT be reconciled), while the
 * pump's real frames flow through the decorator. Both share ONE {@link AnchorState}.
 */
function buildLiveStack(
  stream: Parameters<typeof makeSseSink>[0],
  onForwarded: (r: SseEventRecord) => void,
  resolvedName: string,
  reqId: string,
): { pumpSink: ClientSink; anchorState: AnchorState } {
  const anchorState: AnchorState = { injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false }
  const anchor = anchorHooks()
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  const injector = makeSyntheticAnchorInjector({ anchor, state: anchorState, getSink: () => sinkHolder.current, resolvedName, reqId })
  const inner = makeDeliverySseSink(stream, {
    onForwarded,
    heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor: injector },
  })
  sinkHolder.current = inner
  const pumpSink = makeReconcilingSink(inner, anchorState, anchor)
  return { pumpSink, anchorState }
}

function forwardedSeq(records: Array<SseEventRecord>): Array<string> {
  return records.map((r) => {
    const p = JSON.parse(r.raw) as { type: string; index?: number }
    const k = typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
    return r.synthetic ? `${k}#${r.synthetic}` : k
  })
}

async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// ── the test ─────────────────────────────────────────────────────────────────

describe("live-reconcile collision elimination — injected prelude + live resume yields a single well-formed stream", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  for (const hedgeEnabled of [false, true]) {
    test(`production delivery ${hedgeEnabled ? "with" : "without"} hedge routes winner frames through live reconcile`, async () => {
      const tail = [
        f("message_start", { message: { id: "msg_real" } }),
        f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
        f("message_stop"),
      ]
      const harness = makeHedgedDriver(tail, hedgeEnabled)
      const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
      if (!request.ok) throw new Error("unexpected rejection")
      const { stream: sseStream, written } = stubSseStream()
      const forwarded: Array<SseEventRecord> = []
      const { pumpSink, anchorState } = buildLiveStack(sseStream, (record) => forwarded.push(record), "claude-opus-4.8", `req_hedge_${hedgeEnabled}`)
      const anchor = anchorHooks()

      anchorState.injected = true
      anchorState.contentAnchorInjected = true
      anchorState.messageStartForwarded = true
      anchorState.anchorBlockOpen = true
      await pumpSink.writeSyntheticEnvelope?.(anchor.syntheticMessageStart?.("claude-opus-4.8", `req_hedge_${hedgeEnabled}`) ?? f("message_start"))
      await pumpSink.writeAnchor?.(anchor.startFrame)
      await pumpSink.writeKeepalive?.(anchor.deltaFrame)

      const outcomeP = harness.driver.runResponseSink(request.upstream, request.env, pumpSink, { onUpstreamFrame: () => {} })
      if (hedgeEnabled) {
        await drain()
        await clock.advance(1)
      }
      const outcome = await outcomeP

      expect(outcome.kind).toBe("complete")
      expect(harness.opens()).toBe(hedgeEnabled ? 2 : 1)
      expect(forwardedSeq(forwarded)).toEqual([
        "message_start#synthetic-message-start",
        "content_block_start@0#anchor",
        "content_block_delta@0#keepalive",
        "content_block_stop@0#anchor",
        "content_block_start@1",
        "content_block_delta@1",
        "content_block_stop@1",
        "message_delta",
        "message_stop",
      ])
      expect(written.filter((entry) => JSON.parse(entry.data).type === "message_start")).toHaveLength(1)
      expect(anchorState.anchorClosed).toBe(true)
    })
  }

  test("pre-response silence injects a synthetic prelude; the live resume reconciles (single message_start, anchor@0, real block@1)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({}) // simulate runRequest's first exchange

    // Pure pre-response silence (NO head — the upstream never emits a message_start before the stall),
    // then a real LIVE resume: message_start + a thinking block + terminal.
    const { stream: up, release } = makeSilentThenResume([
      f("message_start", { message: { id: "msg_real" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
      f("message_stop"),
    ])

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const forwarded: Array<SseEventRecord> = []
    const { pumpSink, anchorState } = buildLiveStack(sseStream, (r) => forwarded.push(r), "claude-opus-4.8", "req_e2e")

    const outcomeP = driver.runResponseSink(up, env, pumpSink, { onUpstreamFrame: () => {} })

    // Let the live drain pull the first frame → block on the silent gate (no message_start captured).
    await drain(30)
    expect(anchorState.capturedMessageStart).toBeUndefined()

    // First idle tick → the unique injector synthesizes the full prelude (MS + anchor start@0 + delta@0).
    await clock.advance(15_000)
    await flush()
    expect(anchorState.injected).toBe(true)
    // The second idle tick is delivery's post-scaffold re-arm; the third tick emits the next block-aware
    // empty text_delta@0 keepalive on the still-open anchor.
    await clock.advance(15_000)
    await flush()
    await clock.advance(15_000)
    await flush()

    // Resume the upstream → the real LIVE frames stream through the reconciling decorator.
    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // ── FORWARDED track (type@index#synthetic) ────────────────────────────────────────────────────
    expect(forwardedSeq(forwarded)).toEqual([
      "message_start#synthetic-message-start", // fabricated envelope (no real message_start was available)
      "content_block_start@0#anchor", //          synthetic empty-text anchor block
      "content_block_delta@0#keepalive", //       anchor's first empty text_delta (resets CC's 300s)
      "content_block_delta@0#keepalive", //       third idle-tick keepalive on the open anchor block
      "content_block_stop@0#anchor", //           reconcile close-off (routed via writeAnchor → marked)
      "content_block_start@1", //                 real thinking block, remapped +1 — NO marker
      "content_block_delta@1", //                 real thinking_delta, remapped +1 — NO marker
      "content_block_stop@1", //                  real content_block_stop, remapped +1 — NO marker
      "message_delta", //                         real terminal — no index → unchanged, NO marker
      "message_stop", //                          real — NO marker
    ])

    // ── RAW WIRE bytes (what the client actually receives) ────────────────────────────────────────
    expect(written).toEqual([
      {
        data: JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_synthetic_req_e2e",
            type: "message",
            role: "assistant",
            model: "claude-opus-4.8",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
        event: "message_start",
      },
      { data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), event: "content_block_start" },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), event: "content_block_delta" },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), event: "content_block_delta" },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }), event: "content_block_stop" },
      { data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }), event: "content_block_start" },
      {
        data: JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "reasoning" } }),
        event: "content_block_delta",
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 1 }), event: "content_block_stop" },
      {
        data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }),
        event: "message_delta",
      },
      { data: JSON.stringify({ type: "message_stop" }), event: "message_stop" },
    ])

    // ── Collision-elimination invariants (explicit, redundant with the arrays for regression clarity) ──
    // (1) exactly ONE message_start on the wire (the injected one; the real one was dropped).
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    // (2) exactly ONE content_block_start@0 and it is the synthetic TEXT anchor (real thinking sits at @1).
    const start0 = written.filter((w) => {
      const p = JSON.parse(w.data) as { type: string; index?: number }
      return p.type === "content_block_start" && p.index === 0
    })
    expect(start0).toHaveLength(1)
    expect((JSON.parse(start0[0].data) as { content_block: { type: string } }).content_block.type).toBe("text")
    // (3) the real thinking block is at index 1 (no @0 collision).
    const thinkingStart = written.find((w) => (JSON.parse(w.data) as { content_block?: { type?: string } }).content_block?.type === "thinking")!
    expect((JSON.parse(thinkingStart.data) as { index: number }).index).toBe(1)
    // (4) real usage/stop_reason delivered verbatim on the terminal message_delta.
    const md = written.find((w) => JSON.parse(w.data).type === "message_delta")!
    expect(JSON.parse(md.data)).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })

    pumpSink.close?.()
  })

  // REGRESSION (double message_start on translated /responses long-reasoning, History
  // req_1784035548020_524 et al.): the upstream emits a real message_start EARLY (e.g. /responses
  // `response.created` at t≈0), then falls silent for the whole reasoning phase, THEN resumes with content.
  // The early message_start streams through the reconciling sink BEFORE any idle tick (injected=false →
  // passthrough), which now records `messageStartForwarded`. When the idle tick fires, the injector must
  // open ONLY the anchor (NOT a second message_start). Before the fix the client saw TWO message_starts.
  test("early real message_start + reasoning silence + resume → exactly ONE message_start (no double envelope)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    const { stream: up, release } = makeHeadThenSilentThenResume(
      [f("message_start", { message: { id: "msg_real_early" } })], // early upstream message_start (response.created)
      [
        f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
        f("content_block_stop", { index: 0 }),
        f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        f("message_stop"),
      ],
    )

    const driver = makeDriver()
    const { stream: sseStream, written } = stubSseStream()
    const forwarded: Array<SseEventRecord> = []
    const { pumpSink, anchorState } = buildLiveStack(sseStream, (r) => forwarded.push(r), "gpt-5.6-sol", "req_early")

    const outcomeP = driver.runResponseSink(up, env, pumpSink, { onUpstreamFrame: () => {} })

    // Live drain pulls the early message_start (forwarded via the reconciling sink → records the flag),
    // then blocks on the silent gate.
    await drain(30)
    expect(anchorState.messageStartForwarded).toBe(true)
    expect(anchorState.injected).toBe(false)

    // Idle tick during the reasoning silence → injector opens the anchor ONLY (no second message_start).
    await clock.advance(15_000)
    await flush()
    expect(anchorState.injected).toBe(true)

    release()
    const outcome = await outcomeP
    expect(outcome.kind).toBe("complete")

    // Exactly ONE message_start on the wire — the real early one; the injector added NONE.
    expect(written.filter((w) => JSON.parse(w.data).type === "message_start")).toHaveLength(1)
    expect(JSON.parse(written[0].data).message.id).toBe("msg_real_early")

    // Full forwarded sequence: real MS (unmarked) → anchor prelude → close-off → real content remapped +1.
    expect(forwardedSeq(forwarded)).toEqual([
      "message_start", //                  real early upstream message_start — NO synthetic marker
      "content_block_start@0#anchor", //   synthetic anchor block (opened after the idle tick)
      "content_block_delta@0#keepalive", //anchor's empty text_delta
      "content_block_stop@0#anchor", //    reconcile close-off before the first real block
      "content_block_start@1", //          real text block remapped +1
      "content_block_delta@1", //          real text_delta remapped +1
      "content_block_stop@1", //           real stop remapped +1
      "message_delta", //                  real terminal
      "message_stop",
    ])

    pumpSink.close?.()
  })
})
