/**
 * T4.2/T4.3 — anthropic STREAMING translate-leg END-TO-END round-trip (mock upstream, no GHC / no quota).
 *
 * Drives the REAL anthropic codec + REAL driver's owns-sink streaming path (`runResponseSink`) with a MOCK
 * transport returning a canned upstream CC / Responses SSE stream, into a `makeArraySink` — proving the
 * full FORWARD-leg streaming round-trip WITHOUT a server (no-auto-server):
 *
 *   @cc leg (single hop): upstream CC SSE ─► codec.renderResponse (CC→Anthropic per-frame) ─► Anthropic frames
 *   @responses leg (two hop): upstream Responses SSE ─► Responses→CC→Anthropic ─► Anthropic frames
 *
 * Asserts the Anthropic frame SEQUENCE (message_start … content_block_* … message_delta + message_stop
 * from the codec's flushResponse) AND — the load-bearing byte-critical check — feeds the wire into the
 * REAL @anthropic-ai/sdk `Stream.fromSSEResponse` decoder (the exact one Claude Code uses) so an
 * event-less frame would be caught (N1). Complements the pure-translator SDK oracle in
 * tests/openai/cc-to-anthropic-stream.unit.test.ts (this drives the whole codec+driver seam).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type {
  //
  ClientFrame,
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { preprocessAnthropicMessages } from "~/lib/anthropic/sanitize"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { setModels } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

/** An upstream SSE stream over the given frame strings (data payloads). */
function sseStream(frames: Array<ServerSentEventMessage>): UpstreamStream {
  async function* gen(): AsyncIterable<ServerSentEventMessage> {
    for (const f of frames) yield f
  }
  return { frames: gen(), headers: new Headers() }
}

/** Build the REAL anthropic codec + driver over a mock streaming transport. */
function makeStreamingDriver(upstream: UpstreamStream) {
  const messages = [{ role: "user" as const, content: "hi" }]
  const pre = preprocessAnthropicMessages(messages as never)
  const codec = createAnthropicCodec({
    betaProbe: createBetaProbe(undefined),
    preprocessInfo: { strippedReadTagCount: pre.strippedReadTagCount, dedupedToolCallCount: pre.dedupedToolCallCount },
  })
  const transport: Transport = { send: () => Promise.resolve(upstream) }
  const driver = createPipelineDriver({ codec, transport, strategies: [], maxRetries: 0, maxLearningRetries: 0, requestRewrites: codec.getRequestRewrites() })
  return { codec, driver, rawMessages: pre.messages }
}

/** Run the codec+driver streaming translate leg into an array sink; return the forwarded Anthropic frames + terminal meta. */
async function runStreamingLeg(modelName: string, upstream: UpstreamStream): Promise<{ frames: Array<ClientFrame>; meta: ReturnType<ReturnType<typeof createAnthropicCodec>["getStreamMeta"]> }> {
  const { codec, driver, rawMessages } = makeStreamingDriver(upstream)
  const raw = { body: { model: modelName, max_tokens: 128, messages: rawMessages, stream: true }, headers: new Headers(), path: "/v1/messages", method: "POST" } as unknown as RawHttpRequest
  return withCapturingManager(async () => {
    const result = await driver.runRequest(raw)
    if (!result.ok) throw new Error(`runRequest rejected: ${result.rejection.reason}`)
    const { sink, frames } = makeArraySink()
    const outcome = await driver.runResponseSink(result.upstream, result.env, sink)
    expect(outcome.kind).toBe("complete")
    // flushResponse drains the terminal message_delta + message_stop (mirrors the handler).
    for (const f of codec.flushResponse(result.env)) frames.push(f)
    return { frames, meta: codec.getStreamMeta() }
  }).result
}

/** Serialize forwarded frames into the SSE wire the client receives. */
function toWire(frames: Array<ClientFrame>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("")
}

/** INDEPENDENT ORACLE: decode the forwarded wire through the real Anthropic SDK SSE decoder + reconstruct. */
async function sdkDecode(frames: Array<ClientFrame>): Promise<{ types: Array<string>; text: string; toolNames: Array<string> }> {
  const { Stream } = await import("@anthropic-ai/sdk/core/streaming")
  const response = new Response(toWire(frames), { status: 200, headers: { "content-type": "text/event-stream" } })
  type RawEvent = import("@anthropic-ai/sdk/resources/messages").RawMessageStreamEvent
  const stream = Stream.fromSSEResponse<RawEvent>(response, new AbortController())
  const types: Array<string> = []
  let text = ""
  const toolNames: Array<string> = []
  for await (const ev of stream) {
    types.push(ev.type)
    if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") toolNames.push(ev.content_block.name)
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text
  }
  return { types, text, toolNames }
}

const ccChunk = (obj: unknown): ServerSentEventMessage => ({ data: JSON.stringify(obj), event: "message" })

describe("T4.2 — @cc streaming leg end-to-end (mock CC SSE upstream → forwarded Anthropic frames)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS] })] })

  test("text + tool_use CC stream → forwarded Anthropic frames survive the real SDK decoder", async () => {
    seed()
    const upstream = sseStream([
      ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { content: "Let me check. " }, finish_reason: null }] }),
      ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "toolu_w", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
      ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] }, finish_reason: null }] }),
      ccChunk({ id: "msg_x", model: "claude-x", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 6 } }),
      { data: "[DONE]" },
    ])
    const { frames, meta } = await runStreamingLeg("claude-x@cc", upstream)

    // The forwarded frames terminate with message_delta + message_stop (from flushResponse).
    const types = frames.map((f) => JSON.parse(f.data ?? "{}").type)
    expect(types[0]).toBe("message_start")
    expect(types.at(-2)).toBe("message_delta")
    expect(types.at(-1)).toBe("message_stop")
    // block index allocator: text at 0, tool at 1 (leading text → tool#0 lands at index 1).
    const starts = frames.filter((f) => JSON.parse(f.data ?? "{}").type === "content_block_start").map((f) => JSON.parse(f.data ?? "{}"))
    expect(starts.map((s) => s.index)).toEqual([0, 1])
    expect(meta?.stopReason).toBe("tool_use")

    // INDEPENDENT SDK oracle: the real decoder reconstructs the text + tool_use (no dropped frame).
    const decoded = await sdkDecode(frames)
    expect(decoded.text).toBe("Let me check. ")
    expect(decoded.toolNames).toEqual(["get_weather"])
  })
})

describe("T4.3 — @responses streaming leg end-to-end (mock Responses SSE upstream, two-hop)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({ object: "list", data: [mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.RESPONSES] })] })

  test("Responses SSE → CC → Anthropic frames survive the real SDK decoder (two-hop signal chain)", async () => {
    seed()
    const rEvent = (obj: unknown): ServerSentEventMessage => ({ data: JSON.stringify(obj), event: "message" })
    const upstream = sseStream([
      rEvent({ type: "response.created", response: { id: "resp_1", model: "claude-x" } }),
      rEvent({ type: "response.output_text.delta", delta: "It is sunny." }),
      rEvent({ type: "response.completed", response: { id: "resp_1", model: "claude-x", usage: { input_tokens: 15, output_tokens: 4, total_tokens: 19 } } }),
    ])
    const { frames, meta } = await runStreamingLeg("claude-x@responses", upstream)

    const types = frames.map((f) => JSON.parse(f.data ?? "{}").type)
    expect(types[0]).toBe("message_start")
    expect(types.at(-1)).toBe("message_stop")
    // getStreamMeta signal chain (Responses翻译→CC帧→累积): net usage surfaced.
    expect(meta?.usage.input_tokens).toBe(15)
    expect(meta?.stopReason).toBe("end_turn")

    const decoded = await sdkDecode(frames)
    expect(decoded.text).toBe("It is sunny.")
  })
})
