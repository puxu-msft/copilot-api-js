/**
 * The incident-fix proof (spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.1.5 C1 / §10.2 /
 * §10.8): a LIVE / delayed-commit stream whose upstream is PURELY PRE-RESPONSE silent — it never even
 * emits a `message_start` (production incident `req_1783609043247_663`: 320s, `body:null`, 16 bare
 * pings, 300s CC disconnect).
 *
 * Before the injector relocation the keepalive fell back to a BARE PING in this window (the driver's
 * injector only bound inside `runResponseBufferedSink`, which never runs while `await p` is still
 * pending). This test drives the RELOCATED, handler-owned unique injector attached to the sink's
 * `heartbeat.injectAnchor` at construction — independent of driver/pump — and proves the idle tick now
 * SYNTHESIZES a complete prelude (fabricated message_start + anchor block + empty text_delta) instead of
 * a bare ping, so CC's 300s no-real-content watchdog is reset.
 *
 * Deterministic: FakeClock drives the heartbeat cadence.
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
import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  makeSyntheticAnchorInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import { resolveAnthropicKeepalive } from "~/lib/anthropic/keepalive-frame"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { FakeClock } from "../helpers/fake-clock"
import { decodeSseWrite } from "../helpers/sse-write-stream"

function stubSseStream(): { stream: Parameters<typeof makeDeliverySseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  return { stream, written }
}

/** The AnchorHooks the Anthropic handler supplies (buildAnthropicAnchorWiring), rebuilt here for the unit. */
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
    startFrame: anchorStartFrame,
    stopFrame: anchorStopFrame,
    deltaFrame: anchorDeltaFrame,
    syntheticMessageStart: syntheticMessageStartFrame,
    remap: remapAnthropicBlockIndex,
  }
}

/**
 * Build the handler-owned sink under test: a shared AnchorState (NO captured message_start — the
 * pre-response silence window) + the unique injector attached to `heartbeat.injectAnchor` at
 * construction, self-referencing the sink through a `sinkRef` holder (the injector reads its sink at
 * CALL time, since sink construction args are evaluated before the sink exists — spec §10.1.5 H1).
 */
function buildOnStream(
  stream: Parameters<typeof makeDeliverySseSink>[0],
  onForwarded: (r: SseEventRecord) => void,
  resolvedName: string,
  reqId: string,
): { sink: ClientSink; anchorState: AnchorState } {
  const allocator = createGenerationWireIndexAllocator()
  const wireState = createGenerationWireState(allocator)
  const anchorState: AnchorState = {
    wireState,
    injected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
  const anchor = anchorHooks()
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  const injector = makeSyntheticAnchorInjector({ anchor, state: anchorState, getSink: () => sinkHolder.current, resolvedName, reqId })
  const sink = makeDeliverySseSink(stream, {
    wireState,
    onForwarded,
    heartbeat: {
      intervalSec: 15,
      pingFrame: resolveAnthropicKeepalive("empty_text"),
      injectAnchor: injector,
    },
  })
  sinkHolder.current = sink
  return { sink, anchorState }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function forwardedSeq(records: Array<SseEventRecord>): Array<string> {
  return records.map((r) => {
    const p = JSON.parse(r.raw) as { type: string; index?: number }
    const key = typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
    return r.synthetic ? `${key}#${r.synthetic}` : key
  })
}

describe("live pre-response silence — handler-owned unique injector synthesizes a prelude (not a bare ping)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("first idle tick with NO captured message_start injects [synthetic message_start, anchor start@0, empty text_delta@0]", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink, anchorState } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_pre_response")

    // Pure pre-response silence: no real message_start was ever captured (upstream returned body:null).
    expect(anchorState.capturedMessageStart).toBeUndefined()

    // Advance past the heartbeat cadence → openBlock===undefined → the injector fires.
    await clock.advance(15_000)
    await flush()

    // The forwarded track carries the SYNTHETIC prelude — NOT a bare ping.
    expect(forwardedSeq(forwarded)).toEqual([
      "message_start#synthetic-message-start", // fabricated envelope (fake id + usage:0)
      "content_block_start@0#anchor", //          synthetic empty-text anchor block
      "content_block_delta@0#keepalive", //       the anchor's first empty text_delta (resets CC's 300s)
    ])
    // NO bare ping on the wire.
    expect(stub.written.some((w) => w.event === "ping")).toBe(false)
    // Every prelude frame carries its `event:` line (SDKs silently drop event-less frames).
    expect(stub.written.map((w) => w.event)).toEqual(["message_start", "content_block_start", "content_block_delta"])

    // The synthetic envelope is a well-formed message_start with a fake id + zeroed usage + the resolved model.
    const ms = JSON.parse(stub.written[0].data) as { type: string; message: { id: string; model: string; usage: { input_tokens: number } } }
    expect(ms.type).toBe("message_start")
    expect(ms.message.id).toBe("msg_synthetic_req_pre_response")
    expect(ms.message.model).toBe("claude-opus-4.8")
    expect(ms.message.usage.input_tokens).toBe(0)

    // anchorState reflects the injection (shared with the driver's live/buffered reconciliation).
    expect(anchorState.injected).toBe(true)
    expect(anchorState.messageStartForwarded).toBe(true)
    expect(anchorState.wireState?.allocator.anchorsOpened()).toBe(1)
    expect(anchorState.wireState?.allocator.nextAnchorIndex()).toBe(1)

    sink.close?.()
  })

  test("a later idle tick (open anchor block now lit) emits an empty text_delta@0 keepalive", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_x")

    await clock.advance(15_000) // first tick → synthesize prelude (lights openBlock={0,text})
    await flush()
    // Second idle tick: openBlock={0,text} → the provider yields a block-aware empty text_delta@0.
    await clock.advance(15_000)
    await flush()

    const last = forwarded.at(-1)!
    expect(last.synthetic).toBe("keepalive")
    const p = JSON.parse(last.raw) as { type: string; index: number; delta: { type: string; text: string } }
    expect(p).toMatchObject({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })

    sink.close?.()
  })

  test("when a real message_start WAS captured, the injector forwards it UNMARKED (no synthetic envelope)", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink, anchorState } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_real")
    // Simulate the driver establishing the primary leg before a real frame can be emitted.
    await getDownstreamDeliverySession(sink)?.allocationPort.beginLeg("primary", { candidateId: "candidate-real", dispatchId: "dispatch-real" })
    // Simulate the driver's buffered drain capturing the real message_start into the shared state.
    anchorState.capturedMessageStart = { event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "msg_real" } }) } as ClientFrame

    await clock.advance(15_000)
    await flush()

    expect(forwardedSeq(forwarded)).toEqual([
      "message_start", //                  REAL captured message_start — NO synthetic marker
      "content_block_start@0#anchor",
      "content_block_delta@0#keepalive",
    ])
    expect(JSON.parse(stub.written[0].data).message.id).toBe("msg_real")

    sink.close?.()
  })

  // REGRESSION (double message_start on translated /responses long-reasoning): the LIVE pump can forward a
  // REAL upstream message_start EARLY (e.g. /responses `response.created` at t≈0) and then fall silent for
  // the whole reasoning phase (reasoning frames are not client content). `reconcileLiveFrame` records that
  // passthrough as `messageStartForwarded=true` (no `capturedMessageStart` — that field is buffered-path
  // only). When the idle tick then fires, the injector must NOT fabricate a SECOND message_start (the wire
  // forbids two) — it opens ONLY the anchor block + keepalive delta. Before the fix it emitted a synthetic
  // message_start here, producing the observed [real message_start, synthetic message_start, anchor…]
  // double-envelope (History req_1784035548020_524 et al.).
  test("a real message_start already forwarded by the live pump (messageStartForwarded, no captured) → idle injector opens ONLY the anchor, NO second message_start", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink, anchorState } = buildOnStream(stub.stream, (r) => forwarded.push(r), "gpt-5.6-sol", "req_early_ms")
    // The live pump already forwarded a real upstream message_start (an early /responses response.created)
    // and the reconciling sink recorded it — but nothing was CAPTURED (capturedMessageStart is buffered-only).
    anchorState.messageStartForwarded = true
    expect(anchorState.capturedMessageStart).toBeUndefined()

    await clock.advance(15_000)
    await flush()

    // NO message_start on the wire — only the anchor block + its first empty keepalive delta.
    expect(forwardedSeq(forwarded)).toEqual(["content_block_start@0#anchor", "content_block_delta@0#keepalive"])
    expect(stub.written.some((w) => w.event === "message_start")).toBe(false)
    expect(stub.written.map((w) => w.event)).toEqual(["content_block_start", "content_block_delta"])

    // Injection happened (anchor open) and the flag stays true (exactly one message_start reached the client).
    expect(anchorState.injected).toBe(true)
    expect(anchorState.messageStartForwarded).toBe(true)
    expect(anchorState.anchorBlockOpen).toBe(true)

    sink.close?.()
  })
})
