/**
 * END-TO-END active-path proof for the buffered `empty_text` keepalive ANCHOR (spec
 * 2026-07-08-buffered-keepalive-empty-text-anchor). A real /v1/messages streaming request through
 * the real handler (route → handleMessagesV4 → settled-within-window sink → pumpAnthropicStreamingV4
 * → runResponseBufferedSink), with a TEST-CONTROLLED upstream body so we can:
 *   - open a thinking block that is BUFFERED (protect_streaming_generation = "on" withholds every
 *     real frame until message_stop), so the forward stream has NO open block during the stall,
 *   - stall the upstream past the heartbeat cadence, and observe that the idle tick LAZILY INJECTS a
 *     synthetic empty-text anchor (message_start + content_block_start{text:""}@0 + text_delta ""@0)
 *     — NOT a bare `ping` — so Claude Code's 300s no-real-content watchdog is reset, and
 *   - on commit, close the anchor off (content_block_stop@0) and flush the real blocks REMAPPED to
 *     index+1 (the anchor reserved index 0), with message_start forwarded exactly once.
 *
 * This is the whole point of the feature: the buffered pre-commit window (opus pre-content thinking)
 * previously had NO forwarded open block, so `content_delta` mode could only send a bare ping, which
 * CC does not count as content → ~300s disconnect. The anchor lights a real block to keep alive on.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  anthropicSseFrame,
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  dataFramesOfType,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"
const enc = new TextEncoder()

const thinkingStart = () =>
  anthropicSseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })
const thinkingDelta = (t: string) =>
  anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } })
const signatureDelta = (s: string) =>
  anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: s } })
const blockStop = (i: number) => anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: i })
const messageDelta = () =>
  anthropicSseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
const messageStop = () => anthropicSseFrame("message_stop", { type: "message_stop" })

async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("keepalive buffered-anchor e2e — pre-commit thinking stall injects empty-text anchor (active path)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []

  const fetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL: ${url}`)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
        controllers.push(c)
      },
    })
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
  })

  beforeEach(() => {
    clock.install()
    ctrl = undefined
    controllers.length = 0
    fetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2, // cadence 2s
      streamCommitAfterSec: 10, // large → runRequest settles within window → settled-within-window path
      streamKeepaliveMode: "empty_text", // the mode under test
      protectStreamingGeneration: "on", // buffer EVERY stream → nothing forwarded pre-commit → no open block
      bufferedRetryShared: { maxRetries: 0, bufferCapBytes: 16_777_216, heartbeatSec: 15 }, // no retry (buffer + commit only)
    })
    applyFetchMock(fetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("buffered pre-commit stall injects [message_start, anchor start@0, text_delta ''@0] (not ping); commit closes anchor + remaps real block to @1", async () => {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "keepalive-buffered-anchor-e2e" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
    // Let the handler reach fetch, settle runRequest, open 200, start the buffered pump.
    await drain()
    if (!ctrl) throw new Error("upstream fetch not reached / body controller not captured")
    // Emit message_start + a thinking content_block_start. Both are BUFFERED (protect_streaming on);
    // the driver captures message_start so the idle anchor injector can forward it ahead of the anchor.
    ctrl.enqueue(enc.encode(messageStartFrame({ id: "msg_buffanchor", model: MODEL })))
    await drain(60)
    ctrl.enqueue(enc.encode(thinkingStart()))
    await drain(100) // ensure the buffered loop consumed + captured message_start before the stall
    // Upstream now STALLS. Advance past the 2s cadence → the idle heartbeat fires with NO open block
    // (buffered → nothing forwarded) → it must LAZILY INJECT the anchor (not a bare ping).
    await clock.advance(2_500)
    await drain(100) // let the async injectAnchor's three sink.writes flush
    // Resume: finish the thinking block + terminate → commit.
    ctrl.enqueue(enc.encode(thinkingDelta("reasoning")))
    ctrl.enqueue(enc.encode(signatureDelta("c2ln")))
    ctrl.enqueue(enc.encode(blockStop(0)))
    ctrl.enqueue(enc.encode(messageDelta()))
    ctrl.enqueue(enc.encode(messageStop()))
    ctrl.close()

    const res = await resP
    expect(res.status).toBe(200)
    const text = await res.text()
    const types = frameTypesInOrder(text)

    // (1) NO bare ping — the pre-commit keepalive is the anchor, not a ping.
    expect(types).not.toContain("ping")

    // (2) message_start forwarded exactly once (the injector forwarded it; the commit flush skips the
    //     buffered copy — H1 dedup).
    expect(types.filter((t) => t === "message_start")).toHaveLength(1)

    // (3) the synthetic anchor block: content_block_start{type:"text", text:""} at index 0.
    const starts = dataFramesOfType(text, "content_block_start")
    const anchorStart = starts.find((s) => s.index === 0 && (s.content_block as { type?: string })?.type === "text")
    expect(anchorStart).toBeDefined()
    expect((anchorStart?.content_block as { text?: string })?.text).toBe("")

    // (4) the empty text_delta on the anchor (index 0) — the frame that actually resets CC's 300s.
    const deltas = dataFramesOfType(text, "content_block_delta")
    const anchorDelta = deltas.find(
      (d) => d.index === 0 && (d.delta as { type?: string; text?: string })?.type === "text_delta" && (d.delta as { text?: string }).text === "",
    )
    expect(anchorDelta).toBeDefined()

    // (5) commit closes the anchor off: content_block_stop at index 0.
    const stops = dataFramesOfType(text, "content_block_stop")
    expect(stops.some((s) => s.index === 0)).toBe(true)

    // (6) the REAL thinking block is remapped from index 0 → index 1 (the anchor reserved 0).
    const realThinkingStart = starts.find((s) => s.index === 1 && (s.content_block as { type?: string })?.type === "thinking")
    expect(realThinkingStart).toBeDefined()
    // and its thinking_delta rides index 1, never colliding with the anchor at 0.
    expect(deltas.some((d) => d.index === 1 && (d.delta as { type?: string })?.type === "thinking_delta")).toBe(true)

    // (7) the real terminator survived.
    expect(types).toContain("message_stop")
  })

  test("heartbeat cadence and synthetic markers survive a buffered recovery; recovered real block closes anchor and remaps +1", async () => {
    setStateForTests({ bufferedRetryShared: { maxRetries: 1, bufferCapBytes: 16_777_216, heartbeatSec: 15 } })
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "keepalive-buffered-anchor-recovery" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "recover" }], max_tokens: 256, stream: true }),
    })
    await drain()
    if (!controllers[0]) throw new Error("first upstream body controller was not captured")

    // Attempt 1 exposes only message_start, then stalls. This starts the real buffered pump while no
    // semantic block can commit; the generation-owned heartbeat forwards that envelope + anchor.
    controllers[0].enqueue(enc.encode(messageStartFrame({ id: "msg_attempt_1", model: MODEL })))
    await drain(120)
    const res = await resP
    expect(res.status).toBe(200)
    const textP = res.text() // actively drain the client body so each heartbeat write settles at its fake-clock deadline
    await clock.advance(2_500)
    await drain(100)
    controllers[0].error(new Error("Stream closed with error code NGHTTP2_CANCEL"))
    for (let i = 0; i < 200 && controllers.length < 2; i++) await Promise.resolve()
    if (!controllers[1]) throw new Error("buffered recovery did not open a second upstream body")

    // Attempt 2 starts, but the same downstream sink/cadence remains alive. A second heartbeat lands
    // at the next 2s deadline, proving the retry did not rebuild the sink or reset forwarded markers.
    controllers[1].enqueue(enc.encode(messageStartFrame({ id: "msg_recovered", model: MODEL })))
    await drain(100)
    await clock.advance(2_000)
    await drain(100)

    controllers[1].enqueue(
      enc.encode(anthropicSseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })),
    )
    controllers[1].enqueue(
      enc.encode(anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } })),
    )
    controllers[1].enqueue(enc.encode(blockStop(0)))
    controllers[1].enqueue(enc.encode(messageDelta()))
    controllers[1].enqueue(enc.encode(messageStop()))
    controllers[1].close()

    const text = await textP
    const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const expected = [
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_attempt_1",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "recovered" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 1 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join("")
    expect(text).toBe(expected)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const forwarded =
      getHistory({ endpoint: "anthropic-messages", sessionId: "keepalive-buffered-anchor-recovery", limit: 1 }).entries[0]?.clientResponse?.sseEvents ?? []
    expect(forwarded.filter((frame) => frame.synthetic).map((frame) => frame.synthetic)).toEqual(["anchor", "keepalive", "keepalive", "anchor"])
    const keepaliveOffsets = forwarded.filter((frame) => frame.synthetic === "keepalive").map((frame) => frame.offsetMs)
    expect(keepaliveOffsets).toHaveLength(2)
    expect(keepaliveOffsets[1] - keepaliveOffsets[0]).toBe(2_000)
  })

  test("buffered retries exhausted after heartbeats → scaffold closes exactly once before the terminal error", async () => {
    setStateForTests({ bufferedRetryShared: { maxRetries: 1, bufferCapBytes: 16_777_216, heartbeatSec: 15 } })
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "keepalive-buffered-anchor-exhausted" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "exhaust" }], max_tokens: 256, stream: true }),
    })
    await drain()
    if (!controllers[0]) throw new Error("first upstream body controller was not captured")
    controllers[0].enqueue(enc.encode(messageStartFrame({ id: "msg_exhausted_1", model: MODEL })))
    await drain(120)
    const res = await resP
    expect(res.status).toBe(200)
    const textP = res.text()

    await clock.advance(2_500)
    await drain(100)
    controllers[0].error(new Error("Stream closed with error code NGHTTP2_CANCEL"))
    for (let i = 0; i < 200 && controllers.length < 2; i++) await Promise.resolve()
    if (!controllers[1]) throw new Error("buffered retry did not open a second upstream body")

    await clock.advance(2_000)
    await drain(100)
    controllers[1].error(new Error("Stream closed with error code NGHTTP2_CANCEL"))
    const text = await textP

    const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const expected = [
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_exhausted_1",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("error", { type: "error", error: { type: "api_error", message: "Stream closed with error code NGHTTP2_CANCEL" } }),
    ].join("")
    expect(text).toBe(expected)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "keepalive-buffered-anchor-exhausted", limit: 1 }).entries[0]
    expect(entry?.state).toBe("failed")
    // The terminal raw-stream error frame now carries `error-shaping-canonical` on the forwarded track
    // (Unit 3 §B.2/B.3 — writeSynthetic reads the shapeRawStreamErrorFrame tag), so it is distinguishable
    // from a real upstream error frame. Wire bytes are unchanged (the `text` assertion above still holds).
    expect(entry?.clientResponse?.sseEvents?.filter((frame) => frame.synthetic).map((frame) => frame.synthetic)).toEqual([
      "anchor",
      "keepalive",
      "keepalive",
      "anchor",
      "error-shaping-canonical",
    ])
  })

  test("byte-equivalence control: a FAST buffered response (no stall) injects NO anchor — real block stays at index 0", async () => {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "keepalive-buffered-anchor-fast" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
    await drain()
    if (!ctrl) throw new Error("upstream fetch not reached / body controller not captured")
    // No stall: the whole generation arrives + terminates before the 2s cadence elapses.
    ctrl.enqueue(enc.encode(messageStartFrame({ id: "msg_fast", model: MODEL })))
    ctrl.enqueue(enc.encode(thinkingStart()))
    ctrl.enqueue(enc.encode(thinkingDelta("quick")))
    ctrl.enqueue(enc.encode(signatureDelta("c2ln")))
    ctrl.enqueue(enc.encode(blockStop(0)))
    ctrl.enqueue(enc.encode(messageDelta()))
    ctrl.enqueue(enc.encode(messageStop()))
    ctrl.close()

    const res = await resP
    expect(res.status).toBe(200)
    const text = await res.text()
    const types = frameTypesInOrder(text)
    const starts = dataFramesOfType(text, "content_block_start")

    // No anchor was injected: NO empty-text content_block_start at index 0, and the real thinking block
    // keeps its ORIGINAL index 0 (no +1 remap because no anchor reserved index 0).
    expect(starts.find((s) => s.index === 0 && (s.content_block as { type?: string })?.type === "text")).toBeUndefined()
    const realThinkingStart = starts.find((s) => (s.content_block as { type?: string })?.type === "thinking")
    expect(realThinkingStart?.index).toBe(0)
    expect(types).not.toContain("ping")
    expect(types.filter((t) => t === "message_start")).toHaveLength(1)
    expect(types).toContain("message_stop")
  })
})
