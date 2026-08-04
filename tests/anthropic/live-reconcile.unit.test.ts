/**
 * Unit coverage for the LIVE-path anchor reconciliation (spec §10.3): the pure {@link reconcileLiveFrame}
 * transform (each branch) + the {@link makeReconcilingSink} decorator (write expansion + method forwarding).
 * The end-to-end collision-elimination proof (real driver + decorated sink + injector) lives in
 * tests/pipeline/live-reconcile-collision-e2e.test.ts.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { OwnerRawSink } from "~/lib/pipeline/delivery/types"
import type {
  //
  AnchorState,
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  anchorStopFrame,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  remapAnthropicBlockIndex,
} from "~/lib/anthropic/keepalive-anchor"
import {
  //
  makeReconcilingSink,
  reconcileLiveFrame,
  type ReconcileHooks,
} from "~/lib/anthropic/live-reconcile"

// ── fixtures ──────────────────────────────────────────────────────────────

function f(type: string, extra: Record<string, unknown> = {}): ClientFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

function hooks(): ReconcileHooks {
  return {
    isMessageStart: (fr) => {
      try {
        return typeof fr.data === "string" && (JSON.parse(fr.data) as { type?: string }).type === "message_start"
      } catch {
        return false
      }
    },
    stopFrame: anchorStopFrame,
    remap: remapAnthropicBlockIndex,
  }
}

function injectedState(): AnchorState {
  // The post-injection shared state the handler's empty_text anchor injector leaves behind (message_start +
  // anchor block@0 + empty delta already sent → anchorBlockOpen=true).
  const allocator = createGenerationWireIndexAllocator()
  allocator.onAnchorOpen()
  return {
    wireState: createGenerationWireState(allocator),
    injected: true,
    messageStartForwarded: true,
    anchorBlockOpen: true,
    anchorClosed: false,
  }
}

/** The post-injection state the enveloped_ping ENVELOPE-ONLY injector leaves behind (message_start only, no block). */
function envelopeInjectedState(): AnchorState {
  return {
    wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
    injected: true,
    messageStartForwarded: true,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
}

/** Map a frame to `type@index` (index omitted when absent) for compact sequence assertions. */
function key(fr: ClientFrame): string {
  const p = JSON.parse(fr.data as string) as { type: string; index?: number }
  return typeof p.index === "number" ? `${p.type}@${p.index}` : p.type
}

// ── reconcileLiveFrame — the pure transform ─────────────────────────────────

describe("reconcileLiveFrame", () => {
  test("NOT injected → every frame passes through byte-identically (fast-response equivalence)", () => {
    const state: AnchorState = {
      wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
      injected: false,
      messageStartForwarded: false,
      anchorBlockOpen: false,
      anchorClosed: false,
    }
    const h = hooks()
    const frames = [
      f("message_start", { message: { id: "m" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "x" } }),
      f("message_stop"),
    ]
    for (const fr of frames) {
      const out = reconcileLiveFrame(fr, state, h)
      expect(out).toEqual([fr]) // same object, untouched (WIRE byte-identical)
    }
    // Passthrough leaves the WIRE byte-identical and touches NO structural flag — except it records that a
    // real message_start already went out (`messageStartForwarded`), so a later idle-tick injector won't
    // fabricate a second one. `injected`/`anchorBlockOpen`/`anchorClosed` stay false (no anchor was injected).
    expect(state).toMatchObject({ injected: false, messageStartForwarded: true, anchorBlockOpen: false, anchorClosed: false })
  })

  test("NOT injected + no message_start (pure content) → state stays fully pure", () => {
    const state: AnchorState = {
      wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
      injected: false,
      messageStartForwarded: false,
      anchorBlockOpen: false,
      anchorClosed: false,
    }
    const h = hooks()
    for (const fr of [
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
    ]) {
      expect(reconcileLiveFrame(fr, state, h)).toEqual([fr])
    }
    expect(state).toMatchObject({ injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false })
  })

  test("injected: the real upstream sequence reconciles to [drop MS, stop@0 + block@1, delta@1, stop@1, message_delta, message_stop]", () => {
    const state = injectedState()
    const h = hooks()
    const upstream = [
      f("message_start", { message: { id: "real" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      f("message_stop"),
    ]
    const emitted = upstream.flatMap((fr) => reconcileLiveFrame(fr, state, h))

    expect(emitted.map(key)).toEqual([
      // Closing is an owner side effect; this pure transform only drops the duplicate envelope and remaps.
      "content_block_start@1",
      "content_block_delta@1",
      "content_block_stop@1",
      "message_delta",
      "message_stop",
    ])
    expect(emitted.filter((fr) => key(fr) === "message_start")).toHaveLength(0)
    expect(state.anchorClosed).toBe(false)
  })

  test("injected + message_start → dropped ([]), messageStartForwarded stays set", () => {
    const state = injectedState()
    expect(reconcileLiveFrame(f("message_start", { message: { id: "x" } }), state, hooks())).toEqual([])
    expect(state.messageStartForwarded).toBe(true)
  })

  test("injected + content blocks are remapped while close state stays owner-owned", () => {
    const state = injectedState()
    const h = hooks()
    const first = reconcileLiveFrame(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), state, h)
    const second = reconcileLiveFrame(f("content_block_start", { index: 1, content_block: { type: "text", text: "" } }), state, h)
    expect(first.map(key)).toEqual(["content_block_start@1"])
    expect(second.map(key)).toEqual(["content_block_start@2"])
    expect(state.anchorClosed).toBe(false)
  })

  test("injected: message terminators pass through while owner owns terminal close", () => {
    const state = injectedState()
    const h = hooks()
    const md = f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })
    const ms = f("message_stop")
    expect(reconcileLiveFrame(md, state, h)).toEqual([md])
    expect(reconcileLiveFrame(ms, state, h)).toEqual([ms])
    expect(state.anchorClosed).toBe(false)
  })

  test("injected zero-content completion leaves stop emission to the owner", () => {
    const state = injectedState()
    const h = hooks()
    const md = f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })
    expect(reconcileLiveFrame(md, state, h)).toEqual([md])
    expect(reconcileLiveFrame(f("message_stop"), state, h).map(key)).toEqual(["message_stop"])
    expect(state.anchorClosed).toBe(false)
  })

  test("enveloped_ping (anchorBlockOpen=false): a `message_delta` / `message_stop` before any block passes through, NO stop@0", () => {
    const state = envelopeInjectedState()
    const h = hooks()
    const md = f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })
    expect(reconcileLiveFrame(md, state, h)).toEqual([md]) // no anchor block → nothing to close off
    expect(reconcileLiveFrame(f("message_stop"), state, h).map(key)).toEqual(["message_stop"])
    expect(state.anchorClosed).toBe(false)
  })

  // ── terminal error event before any real block (H2 upstream error / refusal→error rewrite, §10.5) ──────
  test("injected terminal errors pass through while owner emits the balancing stop", () => {
    const state = injectedState()
    const err = f("error", { error: { type: "overloaded_error", message: "overloaded" } })
    expect(reconcileLiveFrame(err, state, hooks())).toEqual([err])
    expect(state.anchorClosed).toBe(false)
  })

  test("enveloped_ping (anchorBlockOpen=false): a terminal `error` event passes through VERBATIM, NO stop@0", () => {
    const state = envelopeInjectedState()
    const err = f("error", { error: { type: "overloaded_error", message: "overloaded" } })
    expect(reconcileLiveFrame(err, state, hooks())).toEqual([err]) // no anchor block → nothing to close off
    expect(state.anchorClosed).toBe(false)
  })

  // ── enveloped_ping: injected + anchorBlockOpen=false (envelope-only, NO anchor block) ────────────────
  test("enveloped_ping (anchorBlockOpen=false): real message_start dropped, real blocks keep ORIGINAL index, NO stop@0", () => {
    const state = envelopeInjectedState()
    const h = hooks()
    const upstream = [
      f("message_start", { message: { id: "real" } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      f("message_stop"),
    ]
    const emitted = upstream.flatMap((fr) => reconcileLiveFrame(fr, state, h))

    // Only the duplicate message_start is dropped; every real block passes through VERBATIM at index 0
    // (no +1 remap) and NO synthetic close-off stop@0 is inserted (there is no anchor block to balance).
    expect(emitted.map(key)).toEqual(["content_block_start@0", "content_block_delta@0", "content_block_stop@0", "message_delta", "message_stop"])
    expect(emitted.filter((fr) => key(fr) === "message_start")).toHaveLength(0)
    // anchorClosed must NOT flip — no close-off happened.
    expect(state.anchorClosed).toBe(false)
    // The real content frames are the SAME objects (no remap allocation) — byte-equivalent passthrough.
    expect(emitted[0]).toBe(upstream[1])
    expect(emitted[1]).toBe(upstream[2])
    expect(emitted[2]).toBe(upstream[3])
  })

  test("enveloped_ping: injected + message_start → dropped ([]), messageStartForwarded stays set", () => {
    const state = envelopeInjectedState()
    expect(reconcileLiveFrame(f("message_start", { message: { id: "x" } }), state, hooks())).toEqual([])
    expect(state.messageStartForwarded).toBe(true)
  })

  test("enveloped_ping: no content_block_* frame is ever remapped (anchor index 0 stays free for the real block)", () => {
    const state = envelopeInjectedState()
    const h = hooks()
    // A multi-block response: both real blocks keep their original indices 0 and 1.
    const b0 = reconcileLiveFrame(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), state, h)
    const b1 = reconcileLiveFrame(f("content_block_start", { index: 1, content_block: { type: "text", text: "" } }), state, h)
    expect(b0.map(key)).toEqual(["content_block_start@0"])
    expect(b1.map(key)).toEqual(["content_block_start@1"])
    expect(state.anchorClosed).toBe(false)
  })
})

// ── makeReconcilingSink — the decorator ─────────────────────────────────────

/** A stub inner sink recording (method, frame) tuples in order. */
function stubSink(): { sink: ClientSink; rawSink: OwnerRawSink; calls: Array<{ m: string; frame?: ClientFrame }> } {
  const calls: Array<{ m: string; frame?: ClientFrame }> = []
  const sink: OwnerRawSink = {
    write: (frame) => (calls.push({ m: "write", frame }), Promise.resolve()),
    writeSynthetic: (frame) => (calls.push({ m: "writeSynthetic", frame }), Promise.resolve()),
    writeKeepalive: (frame) => (calls.push({ m: "writeKeepalive", frame }), Promise.resolve()),
    writeSyntheticEnvelope: (frame) => (calls.push({ m: "writeSyntheticEnvelope", frame }), Promise.resolve()),
    writeAnchor: (frame) => (calls.push({ m: "writeAnchor", frame }), Promise.resolve()),
    freezeHeartbeat: () => calls.push({ m: "freezeHeartbeat" }),
    close: () => calls.push({ m: "close" }),
  }
  return { sink, rawSink: sink, calls }
}

describe("makeReconcilingSink", () => {
  test("NOT injected: write forwards each frame verbatim to inner.write (no anchor routing)", async () => {
    const { sink, calls } = stubSink()
    const state: AnchorState = {
      wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
      injected: false,
      messageStartForwarded: false,
      anchorBlockOpen: false,
      anchorClosed: false,
    }
    const dec = makeReconcilingSink(sink, state, hooks())
    const fr = f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } })
    await dec.write(fr)
    expect(calls).toEqual([{ m: "write", frame: fr }])
  })

  test("injected without a delivery owner remaps but emits no out-of-owner anchor stop", async () => {
    const { sink, calls } = stubSink()
    const dec = makeReconcilingSink(sink, injectedState(), hooks())

    await dec.write(f("message_start", { message: { id: "real" } }))
    await dec.write(f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }))
    await dec.write(f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "r" } }))
    await dec.write(f("content_block_stop", { index: 0 }))
    await dec.write(f("message_stop"))

    expect(calls.map((c) => `${c.m}:${c.frame ? key(c.frame) : ""}`)).toEqual([
      "write:content_block_start@1",
      "write:content_block_delta@1",
      "write:content_block_stop@1",
      "write:message_stop",
    ])
  })

  test("every public non-write method forwards to the inner sink while owner-only anchor capability stays hidden", async () => {
    const { sink, rawSink, calls } = stubSink()
    const dec = makeReconcilingSink(sink, injectedState(), hooks())
    const err = f("error")
    await dec.writeSynthetic?.(err)
    await dec.writeKeepalive?.(err)
    await dec.writeSyntheticEnvelope?.(err)
    await rawSink.writeAnchor?.(err)
    dec.freezeHeartbeat?.()
    dec.close?.()
    expect(calls.map((c) => c.m)).toEqual(["writeSynthetic", "writeKeepalive", "writeSyntheticEnvelope", "writeAnchor", "freezeHeartbeat", "close"])
  })

  test("optional inner methods absent → decorator leaves them undefined (array/WS sinks)", () => {
    const bare: ClientSink = { write: () => Promise.resolve() }
    const dec = makeReconcilingSink(bare, injectedState(), hooks())
    expect(dec.writeSynthetic).toBeUndefined()
    expect("writeAnchor" in dec).toBe(false)
    expect(dec.freezeHeartbeat).toBeUndefined()
    expect(dec.close).toBeUndefined()
  })

  test("a bare sink cannot become a second anchor-close authority", async () => {
    const calls: Array<ClientFrame> = []
    const bare: ClientSink = { write: (frame) => (calls.push(frame), Promise.resolve()) }
    const dec = makeReconcilingSink(bare, injectedState(), hooks())
    await dec.write(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }))
    expect(calls.map(key)).toEqual(["content_block_start@1"])
  })
})
