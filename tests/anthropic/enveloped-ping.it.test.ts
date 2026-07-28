/**
 * `enveloped_ping` mode proof (spec 2026-07-08-buffered-keepalive-empty-text-anchor §10.4 / §10.6): the
 * ENVELOPE-ONLY synthetic prelude. On a pre-response idle stall the handler-owned envelope injector
 * forwards ONLY a synthetic `message_start` (the "message envelope"), then the keepalive falls back to a
 * BARE ping — NO synthetic anchor content block, NO empty text_delta, NO index remap. When the real upstream
 * frames finally arrive, the live reconcile drops the duplicate `message_start` but passes real content
 * blocks through at their ORIGINAL index (no +1) and writes no close-off `stop@0`.
 *
 * This is the leaner sibling of `empty_text` (tests/anthropic/live-pre-response-anchor.test.ts) — kept as an
 * experimental hook (§10.6: expected to still time out at CC's 300s watchdog, NOT a production-safe mode).
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
  makeSyntheticEnvelopeInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
  createGenerationWireIndexAllocator,
} from "~/lib/anthropic/keepalive-anchor"
import { resolveAnthropicKeepalive } from "~/lib/anthropic/keepalive-frame"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { makeSseSink } from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

/** The AnchorHooks the Anthropic handler supplies for enveloped_ping (full frames; the anchor ones stay unused). */
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

/** Build the handler-owned enveloped_ping sink: shared AnchorState + the ENVELOPE-ONLY injector on the heartbeat. */
function buildOnStream(
  stream: Parameters<typeof makeSseSink>[0],
  onForwarded: (r: SseEventRecord) => void,
  resolvedName: string,
  reqId: string,
): { sink: ClientSink; anchorState: AnchorState; anchor: AnchorHooks } {
  const anchorState: AnchorState = {
    allocator: createGenerationWireIndexAllocator(),
    injected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
  const anchor = anchorHooks()
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  const injector = makeSyntheticEnvelopeInjector({ anchor, state: anchorState, getSink: () => sinkHolder.current, resolvedName, reqId })
  const sink = makeSseSink(stream, {
    onForwarded,
    heartbeat: {
      intervalSec: 15,
      pingFrame: resolveAnthropicKeepalive("enveloped_ping"), // = bare ANTHROPIC_PING
      injectAnchor: injector,
    },
  })
  sinkHolder.current = sink
  return { sink, anchorState, anchor }
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

describe("enveloped_ping — envelope-only prelude, then a bare ping (spec §10.6)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("pre-response silence: first idle tick injects ONLY a synthetic message_start — NO anchor block, NO delta", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink, anchorState } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_env_ping")

    expect(anchorState.capturedMessageStart).toBeUndefined() // pure pre-response silence (body:null)

    await clock.advance(15_000)
    await flush()

    // ONLY the synthetic message_start envelope — no content_block_start, no content_block_delta.
    expect(forwardedSeq(forwarded)).toEqual(["message_start#synthetic-message-start"])
    expect(stub.written.map((w) => w.event)).toEqual(["message_start"])

    // The envelope is a well-formed message_start (fake id + zeroed usage + resolved model).
    const ms = JSON.parse(stub.written[0].data) as { type: string; message: { id: string; model: string; usage: { input_tokens: number } } }
    expect(ms.type).toBe("message_start")
    expect(ms.message.id).toBe("msg_synthetic_req_env_ping")
    expect(ms.message.model).toBe("claude-opus-4.8")
    expect(ms.message.usage.input_tokens).toBe(0)

    // Injected, message_start forwarded — but NO anchor block reserved (the enveloped_ping discriminator).
    expect(anchorState.injected).toBe(true)
    expect(anchorState.messageStartForwarded).toBe(true)
    expect(anchorState.anchorBlockOpen).toBe(false)
    expect(anchorState.anchorClosed).toBe(false)

    sink.close?.()
  })

  test("subsequent idle ticks emit a BARE ping (no open block + injector already attempted → fallback)", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_env_ping2")

    await clock.advance(15_000) // tick 1 → synthetic message_start envelope
    await flush()
    await clock.advance(15_000) // tick 2 → bare ping
    await flush()
    await clock.advance(15_000) // tick 3 → bare ping
    await flush()

    // First forwarded frame is the envelope; every later one is a bare ping keepalive (NO anchor block/delta).
    expect(forwardedSeq(forwarded)).toEqual(["message_start#synthetic-message-start", "ping#keepalive", "ping#keepalive"])
    // The wire shows exactly one message_start then bare pings — no content_block_* ever.
    expect(stub.written.map((w) => w.event)).toEqual(["message_start", "ping", "ping"])
    expect(stub.written.some((w) => w.event?.startsWith("content_block"))).toBe(false)

    sink.close?.()
  })

  test("upstream continuation: real message_start dropped, real blocks keep ORIGINAL index, NO stop@0", async () => {
    const forwarded: Array<SseEventRecord> = []
    const stub = stubSseStream()
    const { sink, anchorState, anchor } = buildOnStream(stub.stream, (r) => forwarded.push(r), "claude-opus-4.8", "req_env_cont")

    await clock.advance(15_000) // inject the synthetic message_start envelope
    await flush()

    // The live pump wraps the sink in the reconciliation decorator (same shared anchorState + hooks).
    const reconciling = makeReconcilingSink(sink, anchorState, anchor)

    const upstream: Array<ClientFrame> = [
      { event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: "real" } }) },
      { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) },
      {
        event: "content_block_delta",
        data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      },
      { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      { event: "message_delta", data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) },
      { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
    ]
    for (const fr of upstream) await reconciling.write(fr)
    await flush()

    // Forwarded track: synthetic envelope, then the real blocks at their ORIGINAL index 0 (no remap, no
    // synthetic anchor stop@0). The real message_start is dropped (dedup).
    expect(forwardedSeq(forwarded)).toEqual([
      "message_start#synthetic-message-start",
      "content_block_start@0",
      "content_block_delta@0",
      "content_block_stop@0",
      "message_delta",
      "message_stop",
    ])
    // No synthetic anchor frame was ever written (no "#anchor" marker anywhere).
    expect(forwarded.some((r) => r.synthetic === "anchor")).toBe(false)
    // No content_block_* landed at any index other than the real 0 (no +1 remap).
    const realBlocks = forwarded.filter((r) => forwardedSeq([r])[0].startsWith("content_block"))
    expect(realBlocks.map((r) => forwardedSeq([r])[0])).toEqual(["content_block_start@0", "content_block_delta@0", "content_block_stop@0"])
    expect(anchorState.anchorClosed).toBe(false) // no close-off happened

    sink.close?.()
  })

  test("resolveAnthropicKeepalive('enveloped_ping') is the bare ping frame (not a block-aware provider)", () => {
    const frame = resolveAnthropicKeepalive("enveloped_ping")
    expect(typeof frame).not.toBe("function")
    expect(frame).toEqual({ event: "ping", data: JSON.stringify({ type: "ping" }) })
    // enveloped_ping keepalive === ping keepalive (they differ only in whether a message_start is injected).
    expect(frame).toEqual(resolveAnthropicKeepalive("ping"))
  })
})
