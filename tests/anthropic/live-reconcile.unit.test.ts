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
  return {
    wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
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
      // real message_start → DROPPED (empty), so it never appears
      "content_block_stop@0", //  anchor close-off inserted before the first real block
      "content_block_start@1", // real thinking block, remapped +1
      "content_block_delta@1", // real thinking_delta, remapped +1
      "content_block_stop@1", //  real content_block_stop, remapped +1
      "message_delta", //         no index → unchanged
      "message_stop", //          no index → unchanged
    ])

    // Single message_start on the client (0 real ones survive; the injected one is the only message_start).
    expect(emitted.filter((fr) => key(fr) === "message_start")).toHaveLength(0)
    // No real content_block_* collides with the anchor's reserved index 0 (only the close-off sits at @0).
    const at0 = emitted.filter((fr) => {
      const p = JSON.parse(fr.data as string) as { type: string; index?: number }
      return p.type.startsWith("content_block_") && p.index === 0
    })
    expect(at0.map(key)).toEqual(["content_block_stop@0"]) // exactly the close-off, nothing else at @0
    expect(state.anchorClosed).toBe(true)
  })

  test("injected + message_start → dropped ([]), messageStartForwarded stays set", () => {
    const state = injectedState()
    expect(reconcileLiveFrame(f("message_start", { message: { id: "x" } }), state, hooks())).toEqual([])
    expect(state.messageStartForwarded).toBe(true)
  })

  test("injected + first content_block_start closes the anchor exactly once (later blocks just +1)", () => {
    const state = injectedState()
    const h = hooks()
    const first = reconcileLiveFrame(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), state, h)
    expect(first.map(key)).toEqual(["content_block_stop@0", "content_block_start@1"])
    expect(state.anchorClosed).toBe(true)
    // A SECOND real content_block_start (a multi-block response) must NOT re-close the anchor.
    const second = reconcileLiveFrame(f("content_block_start", { index: 1, content_block: { type: "text", text: "" } }), state, h)
    expect(second.map(key)).toEqual(["content_block_start@2"]) // just +1, no extra stop@0
  })

  test("injected: message_delta / message_stop AFTER a real block closed the anchor pass through unchanged (real usage/stop_reason delivered)", () => {
    const state = injectedState()
    const h = hooks()
    // A real block already closed the anchor (the normal ≥1-block stream) → later terminators pass through.
    reconcileLiveFrame(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), state, h)
    expect(state.anchorClosed).toBe(true)
    const md = f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } })
    const ms = f("message_stop")
    expect(reconcileLiveFrame(md, state, h)).toEqual([md])
    expect(reconcileLiveFrame(ms, state, h)).toEqual([ms])
  })

  // ── zero-content completion: message terminator before any real block (symmetry with buffered commit) ──
  test("injected: a `message_delta` before any real block (zero-content completion) → [stop@0, message_delta]", () => {
    const state = injectedState()
    const h = hooks()
    const md = f("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } })
    const out = reconcileLiveFrame(md, state, h)
    expect(out.map(key)).toEqual(["content_block_stop@0", "message_delta"]) // anchor closed before the terminator
    expect(state.anchorClosed).toBe(true)
    expect(out[1]).toBe(md) // the terminator itself is untouched (no index → remap passthrough)
    // A following message_stop must NOT re-close (idempotent).
    expect(reconcileLiveFrame(f("message_stop"), state, h).map(key)).toEqual(["message_stop"])
  })

  test("injected: a `message_stop` before any real block (no message_delta) → [stop@0, message_stop]", () => {
    const state = injectedState()
    const h = hooks()
    const out = reconcileLiveFrame(f("message_stop"), state, h)
    expect(out.map(key)).toEqual(["content_block_stop@0", "message_stop"])
    expect(state.anchorClosed).toBe(true)
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
  test("injected: a terminal `error` event before any real block → [stop@0, error] (close-off precedes the error)", () => {
    const state = injectedState()
    const h = hooks()
    const err = f("error", { error: { type: "overloaded_error", message: "overloaded" } })
    const out = reconcileLiveFrame(err, state, h)
    // The anchor is closed off (stop@0) BEFORE the forwarded error frame — no OPEN block straight into an error.
    expect(out.map(key)).toEqual(["content_block_stop@0", "error"])
    expect(state.anchorClosed).toBe(true)
    // The error frame itself is untouched (non-content_block_* → remap passes it through verbatim).
    expect(out[1]).toBe(err)
  })

  test("injected: `error` after the anchor was already closed by a real block → no second stop@0", () => {
    const state = injectedState()
    const h = hooks()
    // A real block already closed the anchor.
    reconcileLiveFrame(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), state, h)
    expect(state.anchorClosed).toBe(true)
    // A later error event must NOT re-close (idempotent) — it just passes through.
    const err = f("error", { error: { type: "api_error", message: "x" } })
    expect(reconcileLiveFrame(err, state, h)).toEqual([err])
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
function stubSink(): { sink: ClientSink; calls: Array<{ m: string; frame?: ClientFrame }> } {
  const calls: Array<{ m: string; frame?: ClientFrame }> = []
  const sink: ClientSink = {
    write: (frame) => (calls.push({ m: "write", frame }), Promise.resolve()),
    writeSynthetic: (frame) => (calls.push({ m: "writeSynthetic", frame }), Promise.resolve()),
    writeKeepalive: (frame) => (calls.push({ m: "writeKeepalive", frame }), Promise.resolve()),
    writeSyntheticEnvelope: (frame) => (calls.push({ m: "writeSyntheticEnvelope", frame }), Promise.resolve()),
    writeAnchor: (frame) => (calls.push({ m: "writeAnchor", frame }), Promise.resolve()),
    freezeHeartbeat: () => calls.push({ m: "freezeHeartbeat" }),
    close: () => calls.push({ m: "close" }),
  }
  return { sink, calls }
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

  test("injected: write expands the real sequence onto inner; the close-off routes via writeAnchor (synthetic mark)", async () => {
    const { sink, calls } = stubSink()
    const state = injectedState()
    const dec = makeReconcilingSink(sink, state, hooks())

    await dec.write(f("message_start", { message: { id: "real" } })) // dropped → no inner call
    await dec.write(f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }))
    await dec.write(f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "r" } }))
    await dec.write(f("content_block_stop", { index: 0 }))
    await dec.write(f("message_stop"))

    // The close-off stop@0 is the ONLY writeAnchor call; everything real goes through write, remapped +1.
    expect(calls.map((c) => `${c.m}:${c.frame ? key(c.frame) : ""}`)).toEqual([
      "writeAnchor:content_block_stop@0", // synthetic close-off → marked "anchor" on the forwarded track
      "write:content_block_start@1",
      "write:content_block_delta@1",
      "write:content_block_stop@1",
      "write:message_stop",
    ])
  })

  test("every non-write method forwards to the inner sink", async () => {
    const { sink, calls } = stubSink()
    const dec = makeReconcilingSink(sink, injectedState(), hooks())
    const err = f("error")
    await dec.writeSynthetic?.(err)
    await dec.writeKeepalive?.(err)
    await dec.writeSyntheticEnvelope?.(err)
    await dec.writeAnchor?.(err)
    dec.freezeHeartbeat?.()
    dec.close?.()
    expect(calls.map((c) => c.m)).toEqual(["writeSynthetic", "writeKeepalive", "writeSyntheticEnvelope", "writeAnchor", "freezeHeartbeat", "close"])
  })

  test("optional inner methods absent → decorator leaves them undefined (array/WS sinks)", () => {
    const bare: ClientSink = { write: () => Promise.resolve() }
    const dec = makeReconcilingSink(bare, injectedState(), hooks())
    expect(dec.writeSynthetic).toBeUndefined()
    expect(dec.writeAnchor).toBeUndefined()
    expect(dec.freezeHeartbeat).toBeUndefined()
    expect(dec.close).toBeUndefined()
  })

  test("close-off falls back to inner.write when the inner sink has no writeAnchor", async () => {
    const calls: Array<ClientFrame> = []
    const bare: ClientSink = { write: (frame) => (calls.push(frame), Promise.resolve()) }
    const dec = makeReconcilingSink(bare, injectedState(), hooks())
    await dec.write(f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }))
    expect(calls.map(key)).toEqual(["content_block_stop@0", "content_block_start@1"]) // both via write
  })
})
