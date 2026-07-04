/**
 * END-TO-END active-path proof: a real /v1/messages streaming request through the real handler
 * (route → handleMessagesV4 → settled-within-window sink → pumpAnthropicStreamingV4 →
 * runResponseSink), with a TEST-CONTROLLED upstream body so we can open a thinking block, stall,
 * and observe that the LIVE heartbeat injects an empty thinking_delta (content_delta mode, default)
 * — NOT a bare ping. This is the scenario the user's incident hit (mid-stream pre-content thinking).
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

import { setModels, setStateForTests } from "~/lib/state"

import { anthropicSseFrame, messageStartFrame } from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { dataFramesOfType, frameTypesInOrder } from "../helpers/sse"

const MODEL = "claude-opus-4.8"
const enc = new TextEncoder()

const thinkingStart = () => anthropicSseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })
const thinkingDelta = (t: string) => anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } })
const signatureDelta = (s: string) => anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: s } })
const blockStop = (i: number) => anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: i })
const messageDelta = () => anthropicSseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
const messageStop = () => anthropicSseFrame("message_stop", { type: "message_stop" })

async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("keepalive e2e — mid-stream thinking stall injects content_delta (active path)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

  const fetchMock = mock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL: ${url}`)
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
  })

  beforeEach(() => {
    clock.install()
    ctrl = undefined
    fetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2, // cadence 2s
      streamCommitAfterSec: 10, // large → runRequest settles (Response received) within window → settled-within-window path (:429)
      streamKeepaliveMode: "content_delta", // default; the frame under test
    })
    applyFetchMock(fetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("thinking block opens then upstream stalls → live heartbeat injects EMPTY thinking_delta (not ping)", async () => {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    const resP = app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "keepalive-e2e" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
    // Let the handler reach fetch, settle runRequest, open 200, start the pump.
    await drain()
    if (!ctrl) throw new Error("upstream fetch not reached / body controller not captured")
    // Emit message_start + thinking content_block_start, let the pump consume them (openBlock={0,thinking}).
    ctrl.enqueue(enc.encode(messageStartFrame({ id: "msg_e2e", model: MODEL })))
    await drain(60)
    ctrl.enqueue(enc.encode(thinkingStart()))
    await drain(100) // ensure the pump FORWARDS content_block_start → sink.write sets openBlock={0,thinking} BEFORE the stall
    // Upstream now STALLS. Advance past the 2s cadence → the live sink heartbeat fires.
    await clock.advance(2_500)
    // Resume: finish the thinking block + a tiny text answer + terminate.
    ctrl.enqueue(enc.encode(thinkingDelta("reasoning")))
    ctrl.enqueue(enc.encode(signatureDelta("c2ln")))
    ctrl.enqueue(enc.encode(blockStop(0)))
    ctrl.enqueue(enc.encode(anthropicSseFrame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })))
    ctrl.enqueue(enc.encode(anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } })))
    ctrl.enqueue(enc.encode(blockStop(1)))
    ctrl.enqueue(enc.encode(messageDelta()))
    ctrl.enqueue(enc.encode(messageStop()))
    ctrl.close()

    const res = await resP
    expect(res.status).toBe(200)
    const text = await res.text()
    const types = frameTypesInOrder(text)
    // The keepalive injected during the thinking stall must be a content_block_delta, NOT a ping.
    expect(types).not.toContain("ping")
    const deltas = dataFramesOfType(text, "content_block_delta")
    const emptyThinking = deltas.find((d) => (d.delta as { type?: string; thinking?: string })?.type === "thinking_delta" && (d.delta as { thinking?: string }).thinking === "")
    expect(emptyThinking).toBeDefined() // ← the LIVE handler path injected an empty thinking_delta keepalive
    // And the real content survived intact around it.
    expect(types).toContain("message_stop")
  })
})
