/**
 * C0 golden pre-capture (a) — keepalive-ON LIVE anchored direct `/v1/messages` streaming byte golden.
 *
 * The single HTTP-app byte-for-byte oracle for the LIVE anchored path: `streamKeepalivePingSec > 0` +
 * `streamCommitAfterSec > 0` + `streamKeepaliveMode:"empty_text"` + `protectStreamingGeneration:false`.
 * The upstream STALLS past the commit window + heartbeat cadence → the handler-owned unique injector
 * LAZILY injects the synthetic empty-text anchor (fabricated message_start + `content_block_start@0{text:""}`
 * + empty `text_delta@0`), THEN upstream resumes with real content + terminal → COMMIT reconcile closes the
 * anchor (`content_block_stop@0`) and remaps every real block +1.
 *
 * WHY this is missing (RFC §0.1): the only HTTP-app byte golden `direct-stream-golden-phase4.http.test.ts`
 * turns the heartbeat OFF (`streamKeepalivePingSec:0`), so the anchor injection + commit reconcile BYTES were
 * never locked. Every existing live-anchor HTTP test (`live-post-commit-anchor-closeoff` /
 * `live-pump-terminal-anchor-closeoff` / `keepalive-e2e`) asserts STRUCTURE (`.some(s=>s.index===0)` /
 * `frameTypesInOrder`) — not exact bytes. The only byte-for-byte anchor golden (`buffered-anchor-golden`) is
 * driver-level + the BUFFERED path. This locks the LIVE HTTP-app forwarded bytes, so the CellAssembly refactor
 * (C2 touches the direct-anthropic prepareWire + handler wiring) keeps the anchored stream byte-identical.
 *
 * Deterministic: FakeClock drives the commit window + heartbeat cadence; a gated upstream withholds its SSE
 * until the anchor has been injected during the stall (the drain/advance dance from live-post-commit).
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
import { writeFile } from "node:fs/promises"

import type { DownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import { PATHS } from "~/lib/config/paths"
import { getHistory } from "~/lib/history/store"
import { setDeliverySessionObserverForTests } from "~/lib/pipeline/delivery/session"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  jsonDeltaFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
  toolBlockStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-opus-4.8"

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** Real generation delivered AFTER the anchor is injected: a text block + tool_use + terminal. */
function realFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_c0a", model, inputTokens: 17 }),
    textBlockStartFrame(0),
    textDeltaFrame(0, "Done thinking."),
    blockStopFrame(0),
    toolBlockStartFrame(1, "toolu_c0a", "Write"),
    jsonDeltaFrame(1, '{"file_path":"/tmp/c0.md","content":"# hi"}'),
    blockStopFrame(1),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 23 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

describe("C0 golden (a) — live-anchored keepalive-ON direct stream (byte-for-byte)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let observedDelivery: DownstreamDeliverySession | undefined
  let gateReached: () => void
  let gateReachedP: Promise<void>
  let gateOpenP: Promise<void>
  let openGate: () => void

  const gatedFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
    gateReached()
    return gateOpenP.then(() => createSseResponse(realFrames(payload.model ?? MODEL)))
  })

  beforeEach(() => {
    clock.install()
    observedDelivery = undefined
    setDeliverySessionObserverForTests((session) => {
      observedDelivery = session
    })
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 2,
      streamKeepaliveMode: "empty_text",
      protectStreamingGeneration: false,
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("hedge winner still traverses live reconcile after an anchor opens", async () => {
    await writeFile(
      PATHS.CONFIG_YAML,
      [
        "timeouts:",
        "  response_header: 1",
        "generation:",
        "  hedge:",
        "    enabled: true",
        "    threshold_sec: 0",
        "anthropic:",
        "  stream_keepalive_mode: empty_text",
        "  stream_keepalive_ping_sec: 2",
        "  stream_commit_after_sec: 2",
      ].join("\n"),
    )
    const encoder = new TextEncoder()
    let calls = 0
    let firstOpened!: () => void
    const firstOpenedP = new Promise<void>((resolve) => (firstOpened = resolve))
    let secondaryOpened!: () => void
    const secondaryOpenedP = new Promise<void>((resolve) => (secondaryOpened = resolve))
    let secondaryController: ReadableStreamDefaultController<Uint8Array> | undefined
    const hedgeFetchMock = mock(() => {
      const call = calls++
      if (call === 0) firstOpened()
      else secondaryOpened()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (call === 0) {
            controller.enqueue(encoder.encode(messageStartFrame({ id: "msg_primary_stalled", model: MODEL })))
            controller.enqueue(encoder.encode(textBlockStartFrame(0)))
            controller.enqueue(encoder.encode(textDeltaFrame(0, "PRIMARY-MUST-NOT-LEAK")))
          } else {
            secondaryController = controller
          }
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
    })
    applyFetchMock(hedgeFetchMock)

    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-live-anchor-hedge" },
      body: JSON.stringify({
        model: MODEL,
        system: "load hedge config",
        messages: [{ role: "user", content: "hedge after anchor" }],
        max_tokens: 256,
        stream: true,
      }),
    })
    await firstOpenedP
    await clock.advance(2_000)
    await drain(120)
    await clock.advance(2_500)
    await drain(120)
    await secondaryOpenedP
    expect(calls).toBe(2)
    const res = await resP
    if (!secondaryController) throw new Error("hedge upstream was not opened")
    for (const frame of [
      messageStartFrame({ id: "msg_hedge_winner", model: MODEL }),
      textBlockStartFrame(0),
      textDeltaFrame(0, "secondary complete"),
      blockStopFrame(0),
      messageDeltaFrame({ stopReason: "end_turn", outputTokens: 3 }),
      MESSAGE_STOP_FRAME,
      DONE_FRAME,
    ])
      secondaryController.enqueue(encoder.encode(frame))
    secondaryController.close()

    const text = await res.text()
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as { type: string; index?: number })
    expect(payloads.filter((frame) => frame.type === "message_start")).toHaveLength(1)
    expect(payloads.filter((frame) => frame.type === "content_block_start").map((frame) => frame.index)).toEqual([0, 1])
    expect(payloads.filter((frame) => frame.type === "content_block_stop").map((frame) => frame.index)).toEqual([0, 1])
    expect(payloads.filter((frame) => frame.type === "content_block_delta").map((frame) => frame.index)).toEqual([0, 1])
    expect(text).not.toContain("PRIMARY-MUST-NOT-LEAK")
    expect(observedDelivery?.snapshot.ledger.openBlocks).toEqual([])
  })

  test("stall injects the anchor; upstream resumes → commit reconcile remaps real blocks +1 (frozen bytes)", async () => {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-live-anchored" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "write a file" }], max_tokens: 256, stream: true }),
    })
    await gateReachedP
    await clock.advance(2_000) // commit window fires → 200 SSE opens, callback arms heartbeat + cold-start ping
    await drain(120)
    await clock.advance(2_500) // cadence elapses with NO real frame + NO open block → inject anchor
    await drain(120)
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    openGate() // upstream resumes with the real generation → commit reconcile
    // Normalize the synthetic message_start id (`msg_synthetic_req_<FakeClock-time>_<global-reqId-counter>`):
    // both the time and the counter are volatile across a multi-file run (the reqId counter is a module
    // global that leaks between test files), so lock its SHAPE, not the counter value.
    const text = (await res.text()).replaceAll(/"id":"msg_synthetic_req_\d+_\d+"/g, '"id":"msg_synthetic_req_N"')

    // ── BYTE GOLDEN: the exact forwarded SSE the client receives on the live-anchored path ──────────────
    // Sequence: cold-start ping → synthetic (fabricated) message_start (pre-response silence → id 0'd usage)
    // → anchor block@0 (start + empty text_delta keepalive) → commit close-off (stop@0) → the REAL text/tool
    // blocks remapped +1 (@1, @2) → terminal. The real upstream `message_start` (msg_c0a) is NOT forwarded
    // (H1 dedup — the synthetic one was already sent). No `data: [DONE]` (the pump breaks on it).
    const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const expected = [
      sse("ping", { type: "ping" }),
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_synthetic_req_N",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done thinking." } }),
      sse("content_block_stop", { type: "content_block_stop", index: 1 }),
      sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_c0a", name: "Write", input: {} } }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/c0.md","content":"# hi"}' },
      }),
      sse("content_block_stop", { type: "content_block_stop", index: 2 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 23 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join("")
    expect(text).toBe(expected)
    expect(observedDelivery?.allocationPort.wireState?.activeLeg?.kind).toBe("primary")
    const legSource = observedDelivery?.allocationPort.wireState?.activeLeg?.source
    expect(legSource?.candidateId).toMatch(/^candidate:/)
    expect(legSource?.dispatchId).toMatch(/^dispatch:/)

    // Cross-check invariants the byte golden already encodes (explicit for regression readability):
    // (1) the anchor prelude keepalive is present (this is the keepalive-ON path, not a bare stream).
    expect(text).toContain('"type":"ping"')
    // (2) exactly ONE message_start reaches the wire (synthetic forwarded, real deduped — H1).
    expect(text.match(/"type":"message_start"/g)).toHaveLength(1)
    // (3) the anchor sits at @0 (text) and the real blocks are remapped to @1/@2 (no index collision).
    expect(text).toContain('"index":0,"content_block":{"type":"text","text":""}')
    expect(text).toContain('"index":2,"content_block":{"type":"tool_use"')

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "c0-live-anchored", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })
})
