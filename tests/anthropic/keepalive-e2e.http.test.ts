/**
 * END-TO-END active-path proof: a real /v1/messages streaming request through the real handler
 * (route → handleMessagesV4 → settled-within-window sink → pumpAnthropicStreamingV4 →
 * runResponseSink), with a TEST-CONTROLLED upstream body. Each case opens a real Anthropic block,
 * stalls, and proves the live heartbeat writes the exact empty delta matching that block's index/type.
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

const blockStart = (index: number, type: "thinking" | "text" | "tool_use") =>
  anthropicSseFrame("content_block_start", {
    type: "content_block_start",
    index,
    content_block:
      type === "thinking" ? { type, thinking: "", signature: "" }
      : type === "tool_use" ? { type, id: `toolu_heartbeat_${index}`, name: "Lookup", input: {} }
      : { type, text: "" },
  })
const blockStop = (index: number) => anthropicSseFrame("content_block_stop", { type: "content_block_stop", index })
const messageDelta = () =>
  anthropicSseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })
const messageStop = () => anthropicSseFrame("message_stop", { type: "message_stop" })

interface OpenBlockCase {
  type: "thinking" | "text" | "tool_use"
  index: number
  heartbeatDelta: Record<string, unknown>
  realDelta: Record<string, unknown>
  suffix?: Array<string>
}

const OPEN_BLOCK_CASES: ReadonlyArray<OpenBlockCase> = [
  {
    type: "thinking",
    index: 0,
    heartbeatDelta: { type: "thinking_delta", thinking: "" },
    realDelta: { type: "thinking_delta", thinking: "reasoning" },
    suffix: [anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } })],
  },
  { type: "text", index: 2, heartbeatDelta: { type: "text_delta", text: "" }, realDelta: { type: "text_delta", text: "answer" } },
  {
    type: "tool_use",
    index: 4,
    heartbeatDelta: { type: "input_json_delta", partial_json: "" },
    realDelta: { type: "input_json_delta", partial_json: '{"q":"docs"}' },
  },
]

async function drain(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("keepalive e2e — open Anthropic block stalls use an index/type-matched empty delta", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined

  const fetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL: ${url}`)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
      },
    })
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
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 10,
      streamKeepaliveMode: "empty_text",
    })
    applyFetchMock(fetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  for (const block of OPEN_BLOCK_CASES) {
    test(`${block.type} block@${block.index} → exact empty ${String(block.heartbeatDelta.type)} heartbeat at the same index`, async () => {
      const { createFullTestApp } = await import("../helpers/test-app")
      const app = createFullTestApp()
      const resP = app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": `keepalive-e2e-${block.type}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
      })
      await drain()
      if (!ctrl) throw new Error("upstream fetch not reached / body controller not captured")
      ctrl.enqueue(enc.encode(messageStartFrame({ id: `msg_e2e_${block.type}`, model: MODEL })))
      await drain(60)
      ctrl.enqueue(enc.encode(blockStart(block.index, block.type)))
      await drain(100)

      await clock.advance(2_500)

      ctrl.enqueue(enc.encode(anthropicSseFrame("content_block_delta", { type: "content_block_delta", index: block.index, delta: block.realDelta })))
      for (const frame of block.suffix ?? []) ctrl.enqueue(enc.encode(frame))
      ctrl.enqueue(enc.encode(blockStop(block.index)))
      ctrl.enqueue(enc.encode(messageDelta()))
      ctrl.enqueue(enc.encode(messageStop()))
      ctrl.close()

      const res = await resP
      expect(res.status).toBe(200)
      const text = await res.text()
      const types = frameTypesInOrder(text)
      expect(types).not.toContain("ping")
      const deltas = dataFramesOfType(text, "content_block_delta")
      const expectedHeartbeat = { type: "content_block_delta", index: block.index, delta: block.heartbeatDelta }
      expect(deltas).toContainEqual(expectedHeartbeat)
      expect(text).toContain(anthropicSseFrame("content_block_delta", expectedHeartbeat))
      expect(types).toContain("message_stop")
    })
  }
})
